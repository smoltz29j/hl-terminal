// builder DEX (xyz) の asset id 採番 100000 + dexIndex*10000 + i を実サーバーで検証する。
// 実行: 任意の作業ディレクトリで `npm i ethers@6` 後、
//   NODE_PATH=$PWD/node_modules node tools/verify-xyz-asset-id.mjs
// （リポジトリには node_modules を置かない方針のため NODE_PATH で ethers を解決させる）
//
// 方法 = 復元アドレス法: 未入金・未承認のランダム agent 鍵で /exchange に order を投げると
// "User or API Wallet 0x... does not exist" のエラーにサーバーが署名から復元したアドレスが載る。
// - 復元アドレスが手元の鍵と一致 = サーバーがこの asset id を含む action を我々と同一バイトで
//   msgpack→hash した（署名互換の確認）
// - ⚠検証結果 2026-07-28: サーバーは asset id の存在チェックより先に agent 存在チェックをする
//   （でたらめな id でも同じエラー・復元アドレス一致になる）ため、この方法だけでは採番規則の
//   正しさは証明できない。採番規則そのものは公式 docs（100000 + perp_dex_index*10000 +
//   index_in_meta、例: perp_dex_index=1, index=0 → 110000）と Python SDK info.py
//   （perp_dexs()[1:] の i に対し offset = 110000 + i*10000）の両方で確認済み。
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ethers = require("ethers");
const HLSign = require("/home/smoltz/claude/hyperliquid/hl-sign.js");

const API = "https://api.hyperliquid.xyz";

async function info(body) {
  const r = await fetch(API + "/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tryOrder(label, assetId, px) {
  const wallet = ethers.Wallet.createRandom();
  const action = {
    type: "order",
    orders: [{ a: assetId, b: true, p: px, s: "0.01", r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
  const nonce = Date.now();
  const sig = await HLSign.signL1Action(wallet, action, null, nonce, true, null);
  const r = await fetch(API + "/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature: sig, vaultAddress: null }),
  });
  const text = await r.text();
  const m = text.match(/0x[0-9a-fA-F]{40}/);
  const recovered = m ? m[0] : null;
  const match = recovered && recovered.toLowerCase() === wallet.address.toLowerCase();
  console.log(`--- ${label} (asset=${assetId})`);
  console.log(`    ours:      ${wallet.address}`);
  console.log(`    recovered: ${recovered ?? "(no address in response)"}  match=${match}`);
  console.log(`    http=${r.status} resp=${text.slice(0, 300)}`);
  return { label, assetId, match, text };
}

// 1) dexIndex と銘柄 index を取得
const dexs = await info({ type: "perpDexs" });
const dexIndex = dexs.findIndex((d) => d && d.name === "xyz");
console.log("perpDexs:", dexs.map((d, i) => `${i}:${d ? d.name : "null"}`).slice(0, 8).join(" "), "…");
console.log("xyz dexIndex =", dexIndex);

const [meta] = await info({ type: "metaAndAssetCtxs", dex: "xyz" });
const kIdx = meta.universe.findIndex((u) => u.name === "xyz:KIOXIA");
const gIdx = meta.universe.findIndex((u) => u.name === "xyz:GOLD");
console.log(`xyz:KIOXIA universe index = ${kIdx} (szDecimals=${meta.universe[kIdx].szDecimals})`);
console.log(`xyz:GOLD   universe index = ${gIdx}`);

const kioxiaId = 100000 + dexIndex * 10000 + kIdx;
const goldId = 100000 + dexIndex * 10000 + gIdx;

// 2) 対照実験: 既知の正しい形（メイン DEX の BTC）→ エラー形式のベースライン
const mainMeta = await info({ type: "meta" });
const btcIdx = mainMeta.universe.findIndex((u) => u.name === "BTC");
console.log("main BTC index =", btcIdx, "\n");

const results = [];
results.push(await tryOrder("control: main-dex BTC", btcIdx, "50000"));
results.push(await tryOrder("xyz:KIOXIA computed id", kioxiaId, "200"));
results.push(await tryOrder("xyz:GOLD computed id", goldId, "3000"));
results.push(await tryOrder("bogus id (existence check)", 100000 + dexIndex * 10000 + 9999, "100"));
results.push(await tryOrder("bogus dex (existence check)", 100000 + 250 * 10000 + 1, "100"));

console.log("\n=== summary ===");
for (const r of results) console.log(`${r.match ? "OK " : "?? "} ${r.label}`);
