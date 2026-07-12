"use strict";

// Hyperliquid の署名ロジック（hyperliquid-python-sdk の signing.py と互換）。
// L1 action: msgpack(action) + nonce(8B BE) + vault byte を keccak → phantom agent を
// EIP-712 (Exchange, chainId 1337) で署名。user-signed action: HyperliquidSignTransaction。
// ブラウザでは window.HLSign、node では module.exports（署名検証テスト用）。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("ethers"));
  else root.HLSign = factory(root.ethers);
})(typeof self !== "undefined" ? self : this, function (ethers) {

  // ---- msgpack（必要なサブセットのみ。キーは挿入順で書き出す = SDK と同じ） ----

  function mpPack(v) {
    const out = [];
    mpEnc(v, out);
    return Uint8Array.from(out);
  }

  function mpEnc(v, out) {
    if (v === null || v === undefined) { out.push(0xc0); return; }
    if (typeof v === "boolean") { out.push(v ? 0xc3 : 0xc2); return; }
    if (typeof v === "number" || typeof v === "bigint") { mpEncInt(v, out); return; }
    if (typeof v === "string") { mpEncStr(v, out); return; }
    if (Array.isArray(v)) {
      if (v.length < 16) out.push(0x90 | v.length);
      else if (v.length < 65536) out.push(0xdc, v.length >> 8, v.length & 0xff);
      else throw new Error("msgpack: array too long");
      for (const x of v) mpEnc(x, out);
      return;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length < 16) out.push(0x80 | keys.length);
      else if (keys.length < 65536) out.push(0xde, keys.length >> 8, keys.length & 0xff);
      else throw new Error("msgpack: map too large");
      for (const k of keys) { mpEncStr(k, out); mpEnc(v[k], out); }
      return;
    }
    throw new Error("msgpack: unsupported type " + typeof v);
  }

  function mpEncInt(v, out) {
    if (typeof v === "number" && !Number.isInteger(v)) {
      throw new Error("msgpack: float は送らない（wire 形式は文字列）: " + v);
    }
    const n = BigInt(v);
    if (n < 0n) throw new Error("msgpack: negative int unsupported: " + v);
    if (n < 0x80n) out.push(Number(n));
    else if (n < 0x100n) out.push(0xcc, Number(n));
    else if (n < 0x10000n) out.push(0xcd, Number(n >> 8n), Number(n & 0xffn));
    else if (n < 0x100000000n) {
      out.push(0xce);
      for (let i = 3; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
    } else {
      out.push(0xcf);
      for (let i = 7; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
    }
  }

  function mpEncStr(s, out) {
    const b = new TextEncoder().encode(s);
    if (b.length < 32) out.push(0xa0 | b.length);
    else if (b.length < 256) out.push(0xd9, b.length);
    else if (b.length < 65536) out.push(0xda, b.length >> 8, b.length & 0xff);
    else throw new Error("msgpack: string too long");
    out.push(...b);
    return;
  }

  // ---- action hash & L1 署名 ----

  function u64be(n) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n));
    return b;
  }

  function actionHash(action, vaultAddress, nonce, expiresAfter) {
    const parts = [mpPack(action), u64be(nonce)];
    if (vaultAddress == null) parts.push(Uint8Array.of(0));
    else parts.push(Uint8Array.of(1), ethers.getBytes(vaultAddress));
    if (expiresAfter != null) parts.push(Uint8Array.of(0), u64be(expiresAfter));
    return ethers.keccak256(ethers.concat(parts));
  }

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const AGENT_TYPES = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };

  function splitSig(sigHex) {
    const s = ethers.Signature.from(sigHex);
    return { r: s.r, s: s.s, v: s.v };
  }

  // wallet = ethers.Wallet（agent 鍵）。返り値 {r,s,v}
  async function signL1Action(wallet, action, vaultAddress, nonce, isMainnet, expiresAfter) {
    const hash = actionHash(action, vaultAddress ?? null, nonce, expiresAfter ?? null);
    const phantomAgent = { source: isMainnet ? "a" : "b", connectionId: hash };
    const domain = { chainId: 1337, name: "Exchange", verifyingContract: ZERO_ADDR, version: "1" };
    const sig = await wallet.signTypedData(domain, AGENT_TYPES, phantomAgent);
    return splitSig(sig);
  }

  // ---- user-signed action（approveAgent 等。MetaMask の eth_signTypedData_v4 に渡す形） ----

  const EIP712_DOMAIN_TYPES = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];

  const APPROVE_AGENT_SIGN_TYPES = [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ];

  // action には signatureChainId (hex) / hyperliquidChain を含めておくこと
  function userSignedTypedData(primaryType, signTypes, action) {
    const message = {};
    for (const t of signTypes) message[t.name] = action[t.name];
    return {
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: Number(BigInt(action.signatureChainId)),
        verifyingContract: ZERO_ADDR,
      },
      types: { EIP712Domain: EIP712_DOMAIN_TYPES, [primaryType]: signTypes },
      primaryType,
      message,
    };
  }

  // ---- wire 形式（SDK の float_to_wire と同じ丸め検査つき） ----

  function floatToWire(x) {
    const rounded = x.toFixed(8);
    if (Math.abs(parseFloat(rounded) - x) >= 1e-12) throw new Error("float_to_wire rounding: " + x);
    let s = rounded.replace(/0+$/, "").replace(/\.$/, "");
    if (s === "-0" || s === "") s = "0";
    return s;
  }

  return {
    mpPack, actionHash, signL1Action, splitSig, floatToWire,
    userSignedTypedData, APPROVE_AGENT_SIGN_TYPES, ZERO_ADDR,
  };
});
