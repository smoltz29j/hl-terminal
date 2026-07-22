"use strict";

// 発注機能。API ウォレット方式:
// 1. MetaMask で approveAgent（user-signed EIP-712）に署名して agent 鍵を承認
// 2. 以後の order/cancel は agent 鍵（localStorage 保存）で L1 署名し POST /exchange
// メイン秘密鍵はブラウザに存在せず、agent 鍵では出金・送金は不可。
// 署名の実体は hl-sign.js（Python SDK と互換であることを検証済み）。

const AGENT_NAME = "hlterm";
const MARKET_SLIPPAGE = 0.05; // 成行 = IOC 指値。mark からの許容乖離（SDK デフォルトと同じ）

const trade = {
  side: "buy",     // "buy" | "sell"
  type: "limit",   // "limit" | "market"
  agent: null,     // ethers.Wallet（承認済み agent 鍵）
  busy: false,
  levCross: true,  // レバレッジ変更 UI のマージンモード（true=Cross）
};

function agentStoreKey(user) {
  return `hlt-agent:${NET.isMainnet ? "mainnet" : "testnet"}:${user.toLowerCase()}`;
}

function loadAgent() {
  try {
    const raw = localStorage.getItem(agentStoreKey(state.user));
    return raw ? new ethers.Wallet(JSON.parse(raw).key) : null;
  } catch { return null; }
}

function dropAgent() {
  if (state.user) localStorage.removeItem(agentStoreKey(state.user));
  trade.agent = null;
}

function tradeReady() {
  return !!(trade.agent && state.user && state.userSource === "mm");
}

// ---------- /exchange ----------

async function exchangePost(action, signature, nonce) {
  const r = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter: null }),
  });
  let j;
  try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
  if (j.status !== "ok") throw new Error(typeof j.response === "string" ? j.response : JSON.stringify(j.response ?? j));
  return j.response;
}

// ---------- 数値の wire 化 ----------

// 成行用: mark±slippage を「有効数字5桁 + 小数 (6 - szDecimals) 桁」に丸める（SDK と同じ規則）
function slippagePx(isBuy, szd) {
  if (!(state.markPx > 0)) throw new Error(T("mark 価格が未取得です", "Mark price unavailable"));
  let px = state.markPx * (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE);
  px = Number(px.toPrecision(5));
  return Number(px.toFixed(Math.max(0, 6 - szd)));
}

function parsePositive(s, label) {
  // 全角数字・全角ピリオド・カンマ・空白を許容して正規化（IME オンのまま入力されるケース対策）
  const t = String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/[,，\s]/g, "");
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(T(`${label}が不正です: 「${s}」`, `Invalid ${label}: "${s}"`));
  return n;
}

// ---------- 取引の有効化（approveAgent） ----------

async function enableTrading() {
  const btn = $("tg-btn");
  btn.disabled = true;
  try {
    tradeStatus(T("MetaMask で承認待ち…", "Waiting for MetaMask approval…"));
    const agent = ethers.Wallet.createRandom();
    const nonce = Date.now();
    const chainIdHex = await mmProvider.request({ method: "eth_chainId" });
    const action = {
      type: "approveAgent",
      signatureChainId: chainIdHex,
      hyperliquidChain: NET.isMainnet ? "Mainnet" : "Testnet",
      agentAddress: agent.address,
      agentName: AGENT_NAME,
      nonce,
    };
    const typed = HLSign.userSignedTypedData("HyperliquidTransaction:ApproveAgent", HLSign.APPROVE_AGENT_SIGN_TYPES, action);
    const sigHex = await mmProvider.request({
      method: "eth_signTypedData_v4",
      params: [state.user, JSON.stringify(typed)],
    });
    tradeStatus(T("承認を送信中…", "Submitting approval…"));
    await exchangePost(action, HLSign.splitSig(sigHex), nonce);
    localStorage.setItem(agentStoreKey(state.user), JSON.stringify({
      key: agent.privateKey, address: agent.address, name: AGENT_NAME, approvedAt: Date.now(),
    }));
    trade.agent = agent;
    tradeStatus(T("取引を有効化しました", "Trading enabled"), "ok");
    renderTradePane();
    refreshAccount();
    refreshLeverage();
  } catch (e) {
    console.error("approveAgent:", e);
    tradeStatus(errMsg(e), "err");
  } finally {
    btn.disabled = false;
  }
}

function errMsg(e) {
  const m = String(e?.message ?? e);
  if (/must deposit/i.test(m)) return T(`このアカウントは ${NET.isMainnet ? "mainnet" : "testnet"} に入金がありません`, `This account has no deposit on ${NET.isMainnet ? "mainnet" : "testnet"}`);
  if (/user rejected|denied/i.test(m)) return T("署名がキャンセルされました", "Signature cancelled");
  return m.length > 200 ? m.slice(0, 200) + "…" : m;
}

// ---------- 発注・キャンセル ----------

async function submitOrder() {
  if (trade.busy || !tradeReady()) return;
  const coin = state.coin;
  const asset = state.assetIds[coin];
  const szd = state.szDecimals[coin] ?? 0;
  const isBuy = trade.side === "buy";
  try {
    if (asset == null) throw new Error(T("この銘柄は発注に未対応です", "Ordering is not supported for this symbol"));
    const sz = Number(parsePositive($("tf-sz").value, T("数量", "size")).toFixed(szd));
    if (sz <= 0) throw new Error(T(`数量が最小単位（${Math.pow(10, -szd)}）未満です`, `Size is below the minimum unit (${Math.pow(10, -szd)})`));
    let px, tif;
    if (trade.type === "market") { px = slippagePx(isBuy, szd); tif = "Ioc"; }
    else { px = parsePositive($("tf-px").value, T("価格", "price")); tif = "Gtc"; }

    const label = T(`${coin} ${isBuy ? "買い" : "売り"} ${sz} @ ${trade.type === "market" ? "成行" : px}`,
      `${coin} ${isBuy ? "Buy" : "Sell"} ${sz} @ ${trade.type === "market" ? "market" : px}`);
    if (NET.isMainnet && !confirm(T(`【Mainnet — 実資金】\n${label}\n送信しますか？`, `[Mainnet — real funds]\n${label}\nSend?`))) return;

    trade.busy = true;
    $("tf-submit").disabled = true;
    tradeStatus(T("送信中…", "Sending…"));

    const order = {
      a: asset, b: isBuy,
      p: HLSign.floatToWire(px), s: HLSign.floatToWire(sz),
      r: $("tf-ro").checked,
      t: { limit: { tif } },
    };
    const action = { type: "order", orders: [order], grouping: "na" };
    const nonce = Date.now();
    const sig = await HLSign.signL1Action(trade.agent, action, null, nonce, NET.isMainnet);
    const resp = await exchangePost(action, sig, nonce);

    const st = resp?.data?.statuses?.[0] ?? {};
    if (st.error) throw new Error(st.error);
    if (st.filled) tradeStatus(T(`約定: ${st.filled.totalSz} @ ${st.filled.avgPx}`, `Filled: ${st.filled.totalSz} @ ${st.filled.avgPx}`), "ok");
    else if (st.resting) tradeStatus(T(`板に登録（oid ${st.resting.oid}）`, `Resting on book (oid ${st.resting.oid})`), "ok");
    else tradeStatus(T("送信しました", "Sent"), "ok");
    refreshAccount();
  } catch (e) {
    console.error("order:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
  } finally {
    trade.busy = false;
    $("tf-submit").disabled = false;
  }
}

async function cancelOrder(coin, oid) {
  if (!tradeReady()) return;
  try {
    const action = { type: "cancel", cancels: [{ a: state.assetIds[coin], o: oid }] };
    const nonce = Date.now();
    const sig = await HLSign.signL1Action(trade.agent, action, null, nonce, NET.isMainnet);
    const resp = await exchangePost(action, sig, nonce);
    const st = resp?.data?.statuses?.[0];
    if (st && st.error) throw new Error(st.error);
    tradeStatus(T(`キャンセルしました（oid ${oid}）`, `Cancelled (oid ${oid})`), "ok");
    refreshAccount();
  } catch (e) {
    console.error("cancel:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
    alert(T("キャンセルに失敗:\n", "Cancel failed:\n") + errMsg(e));
  }
}

// 既存指値の価格・数量を変更（batchModify）。tif / reduceOnly は元の注文から引き継ぐ
async function modifyOrder(oid) {
  if (!tradeReady()) return;
  const o = state.openOrders.find((x) => x.oid === oid);
  if (!o) { tradeStatus(T("注文が見つかりません（更新直後の可能性）", "Order not found (it may have just changed)"), "err"); return; }
  try {
    const pxIn = prompt(T(`${o.coin} ${o.side === "B" ? "買い" : "売り"} の新しい価格:`, `New price for ${o.coin} ${o.side === "B" ? "buy" : "sell"}:`), o.limitPx);
    if (pxIn === null) return;
    const szIn = prompt(T("新しい数量:", "New size:"), o.sz);
    if (szIn === null) return;
    const px = parsePositive(pxIn, T("価格", "price"));
    const szd = state.szDecimals[o.coin] ?? 0;
    const sz = Number(parsePositive(szIn, T("数量", "size")).toFixed(szd));
    if (sz <= 0) throw new Error(T(`数量が最小単位（${Math.pow(10, -szd)}）未満です`, `Size is below the minimum unit (${Math.pow(10, -szd)})`));

    if (NET.isMainnet && !confirm(T(`【Mainnet — 実資金】\n${o.coin} 注文 ${oid} を修正:\n${o.limitPx} → ${px} / ${o.sz} → ${sz}\n送信しますか？`, `[Mainnet — real funds]\nModify ${o.coin} order ${oid}:\n${o.limitPx} → ${px} / ${o.sz} → ${sz}\nSend?`))) return;

    tradeStatus(T("修正を送信中…", "Submitting modify…"));
    const action = {
      type: "batchModify",
      modifies: [{
        oid,
        order: {
          a: state.assetIds[o.coin], b: o.side === "B",
          p: HLSign.floatToWire(px), s: HLSign.floatToWire(sz),
          r: !!o.reduceOnly,
          t: { limit: { tif: o.tif } },
        },
      }],
    };
    const nonce = Date.now();
    const sig = await HLSign.signL1Action(trade.agent, action, null, nonce, NET.isMainnet);
    const resp = await exchangePost(action, sig, nonce);
    const st = resp?.data?.statuses?.[0] ?? {};
    if (st.error) throw new Error(st.error);
    tradeStatus(T(`修正しました（oid ${st.resting?.oid ?? oid}）`, `Modified (oid ${st.resting?.oid ?? oid})`), "ok");
    refreshAccount();
  } catch (e) {
    console.error("modify:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
    alert(T("注文修正に失敗:\n", "Modify failed:\n") + errMsg(e)); // テーブル操作はステータス行が目に入りにくいため明示
  }
}

// ポジションをクローズ（Reduce Only）。数量指定で部分クローズ、価格指定で指値クローズ可
async function closePosition(coin) {
  if (!tradeReady()) return;
  const p = state.positions.find((x) => x.coin === coin);
  if (!p) { tradeStatus(T("ポジションが見つかりません", "Position not found"), "err"); return; }
  try {
    const szi = Number(p.szi);
    const isBuy = szi < 0; // ショートは買い戻し、ロングは売り
    const maxSz = Math.abs(szi);
    const asset = state.assetIds[coin];
    if (asset == null) throw new Error(T("この銘柄はクローズ操作に未対応です", "Closing is not supported for this symbol"));
    const szd = state.szDecimals[coin] ?? 0;

    const szIn = prompt(T(`${coin} のクローズ数量（最大 ${maxSz}）:`, `Close size for ${coin} (max ${maxSz}):`), maxSz);
    if (szIn === null) return;
    const sz = Number(parsePositive(szIn, T("数量", "size")).toFixed(szd));
    if (sz - maxSz > 1e-12) throw new Error(T(`ポジションサイズ（${maxSz}）を超えています`, `Exceeds the position size (${maxSz})`));

    const pxIn = prompt(T("指値価格（空欄なら成行）:", "Limit price (blank = market):"), "");
    if (pxIn === null) return;
    let px, tif, kind;
    if (pxIn.trim() === "") {
      // 成行 = IOC。mark はポジションの値から算出（チャート表示外の銘柄でも取れる）
      const mark = Number(p.positionValue) / maxSz;
      if (!(mark > 0)) throw new Error(T("mark 価格を取得できません", "Mark price unavailable"));
      px = mark * (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE);
      px = Number(px.toPrecision(5));
      px = Number(px.toFixed(Math.max(0, 6 - szd)));
      tif = "Ioc";
      kind = T("成行", "market");
    } else {
      px = parsePositive(pxIn, T("価格", "price"));
      tif = "Gtc";
      kind = T(`指値 ${px}`, `limit ${px}`);
    }

    if (!confirm(T(`${NET.isMainnet ? "【Mainnet — 実資金】\n" : ""}${coin} ポジション ${p.szi} のうち ${sz} を${kind}でクローズしますか？`,
      `${NET.isMainnet ? "[Mainnet — real funds]\n" : ""}Close ${sz} of the ${coin} position (${p.szi}) at ${kind}?`))) return;

    tradeStatus(T("クローズを送信中…", "Submitting close…"));
    const order = {
      a: asset, b: isBuy,
      p: HLSign.floatToWire(px), s: HLSign.floatToWire(sz),
      r: true,
      t: { limit: { tif } },
    };
    const action = { type: "order", orders: [order], grouping: "na" };
    const nonce = Date.now();
    const sig = await HLSign.signL1Action(trade.agent, action, null, nonce, NET.isMainnet);
    const resp = await exchangePost(action, sig, nonce);
    const st = resp?.data?.statuses?.[0] ?? {};
    if (st.error) throw new Error(st.error);
    if (st.filled) tradeStatus(T(`クローズ約定: ${st.filled.totalSz} @ ${st.filled.avgPx}`, `Close filled: ${st.filled.totalSz} @ ${st.filled.avgPx}`), "ok");
    else if (st.resting) tradeStatus(T(`クローズ指値を板に登録（oid ${st.resting.oid}）`, `Close limit resting (oid ${st.resting.oid})`), "ok");
    else tradeStatus(T("クローズ注文を送信しました", "Close order sent"), "ok");
    refreshAccount();
  } catch (e) {
    console.error("close:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
    alert(T("クローズに失敗:\n", "Close failed:\n") + errMsg(e));
  }
}

// agent 鍵が失効/未承認になっていたら破棄して再有効化を促す
// ---------- レバレッジ変更（updateLeverage） ----------

// 現在値を activeAssetData から取得して UI へ反映。銘柄切替・接続直後に呼ぶ。
// 非対応銘柄（builder DEX 等 asset id 未登録）では行ごと隠す
async function refreshLeverage() {
  const row = $("tf-lev-row");
  const coin = state.coin;
  const asset = state.assetIds[coin];
  if (!tradeReady() || asset == null) { row.hidden = true; return; }
  row.hidden = false;
  $("tf-lev-max").textContent = T(`x（最大 ${state.maxLev[coin] ?? "?"}）`, `x (max ${state.maxLev[coin] ?? "?"})`);
  try {
    const d = await info({ type: "activeAssetData", user: state.user, coin });
    if (state.coin !== coin) return; // 取得中に銘柄が切り替わったら破棄
    $("tf-lev").value = String(d.leverage?.value ?? "");
    setMarginMode(d.leverage?.type !== "isolated");
  } catch (e) {
    console.error("activeAssetData:", e);
  }
}

function setMarginMode(isCross) {
  trade.levCross = isCross;
  document.querySelector("#tf-margin .active")?.classList.remove("active");
  document.querySelector(`#tf-margin button[data-mode="${isCross ? "cross" : "isolated"}"]`)?.classList.add("active");
}

async function setLeverage() {
  if (trade.busy || !tradeReady()) return;
  const coin = state.coin;
  const asset = state.assetIds[coin];
  const btn = $("tf-lev-set");
  try {
    if (asset == null) throw new Error(T("この銘柄はレバレッジ変更に未対応です", "Leverage change is not supported for this symbol"));
    const max = state.maxLev[coin] ?? 1;
    const lev = Math.round(parsePositive($("tf-lev").value, T("レバレッジ", "leverage")));
    if (lev < 1 || lev > max) throw new Error(T(`レバレッジは 1〜${max} の整数で指定してください`, `Leverage must be an integer between 1 and ${max}`));
    const modeTxt = trade.levCross ? "Cross" : "Isolated";
    if (NET.isMainnet && !confirm(T(`【Mainnet】${coin} のレバレッジを ${lev}x（${modeTxt}）に変更します。\nポジションがある場合は必要証拠金・清算価格が変わります。よろしいですか？`, `[Mainnet] Change ${coin} leverage to ${lev}x (${modeTxt}).\nMargin requirement and liquidation price of existing positions will change. OK?`))) return;

    trade.busy = true;
    btn.disabled = true;
    tradeStatus(T("レバレッジ変更中…", "Updating leverage…"));
    // msgpack はキー順序がハッシュに影響する。Python SDK update_leverage と同じ
    // type, asset, isCross, leverage の順を崩さないこと
    const action = { type: "updateLeverage", asset, isCross: trade.levCross, leverage: lev };
    const nonce = Date.now();
    const sig = await HLSign.signL1Action(trade.agent, action, null, nonce, NET.isMainnet);
    await exchangePost(action, sig, nonce);
    tradeStatus(T(`${coin} のレバレッジを ${lev}x（${modeTxt}）に変更しました`, `${coin} leverage set to ${lev}x (${modeTxt})`), "ok");
    refreshAccount();
    refreshLeverage();
  } catch (e) {
    console.error("updateLeverage:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
  } finally {
    trade.busy = false;
    btn.disabled = false;
  }
}

// ---------- 入出金（Bridge2） ----------
// 入金 = Arbitrum 上で native USDC をブリッジコントラクトへ ERC-20 transfer（MetaMask の通常 tx）。
// 出金 = user-signed action withdraw3（メインウォレットの EIP-712 署名。agent 鍵では署名不可）。
// アドレス4件は docs の Bridge2 ページ原文と突き合わせ済み（2026-07-22）。
// ⚠ ブリッジは native USDC のみ受け付ける（USDC.e 不可）。最小入金 5 USDC 未満は返金されず消失。
const BRIDGE = {
  mainnet: {
    chainId: "0xa4b1", chainName: "Arbitrum One",
    bridge: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  testnet: {
    chainId: "0x66eee", chainName: "Arbitrum Sepolia",
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
  },
};
const MIN_DEPOSIT = 5;    // USDC。未満はブリッジに没収される
const MIN_WITHDRAW = 2;   // USDC
const WITHDRAW_FEE = 1;   // USDC（バリデータが負担する Arbitrum ガス代の原資）

// 入出金はメインウォレットの署名が要る = MetaMask 接続時のみ（agent 鍵・ウォッチ不可）
function xferReady() {
  return !!(state.user && state.userSource === "mm" && mmProvider);
}

// user-signed 署名・送金の前に MetaMask を所定の Arbitrum チェーンへ揃える。
// 入金は誤チェーン送金防止のため必須。出金/振替でも、SDK が返す chainId と拡張の実チェーンが
// 食い違うと eth_signTypedData_v4 が「Provided chainId does not match」で拒否されるため、
// 先に切替してチェーンを確定させる（公式アプリも signatureChainId は Arbitrum 固定）。
// 返り値 = 以後 signatureChainId に使う chainId(hex)
async function ensureWalletChain() {
  const B = NET.isMainnet ? BRIDGE.mainnet : BRIDGE.testnet;
  const cur = await mmProvider.request({ method: "eth_chainId" });
  if (cur !== B.chainId) {
    tradeStatus(T(`MetaMask を ${B.chainName} に切替中…`, `Switching MetaMask to ${B.chainName}…`));
    await mmProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: B.chainId }] });
  }
  return B.chainId;
}

// 入出金用モーダル（prompt/confirm はフォント・色を弄れないため自前 — ユーザー要望 2026-07-22）。
// input を渡すと入力ダイアログ（入力文字列 or null を返す）、省略で確認ダイアログ（true or null）。
// html には数値・自前文言・アドレスのみ入れること（ユーザー入力を埋め込まない）
function xferDialog({ title, html, input = null, okLabel }) {
  return new Promise((resolve) => {
    const modal = $("xfer-modal");
    const inp = $("xm-input");
    $("xm-title").textContent = title;
    $("xm-body").innerHTML = html;
    $("xm-ok").textContent = okLabel || "OK";
    $("xm-cancel").textContent = T("キャンセル", "Cancel");
    inp.hidden = input === null;
    inp.value = input ?? "";
    modal.hidden = false;
    const done = (v) => {
      modal.hidden = true;
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter") done(input === null ? true : inp.value);
    };
    $("xm-ok").onclick = () => done(input === null ? true : inp.value);
    $("xm-cancel").onclick = () => done(null);
    modal.onclick = (e) => { if (e.target === modal) done(null); };
    document.addEventListener("keydown", onKey);
    if (input !== null) { inp.focus(); inp.select(); }
  });
}

async function withdrawFunds() {
  if (trade.busy || !xferReady()) return;
  try {
    const wd = state.withdrawable;
    // 出金は Perps 残高からのみ（withdraw3）。資金が Spot にあるときはその旨を案内
    const spotHint = (state.spotUsdc ?? 0) > 0 && wd < MIN_WITHDRAW
      ? T(`<br><span class="xm-danger">Spot に ${state.spotUsdc} USDC があります — 出金は Perps 残高からのみ。先に「振替」で Perps へ移してください</span>`,
          `<br><span class="xm-danger">You have ${state.spotUsdc} USDC in spot — withdrawals draw from perps only. Use Transfer first.</span>`)
      : "";
    const amtIn = await xferDialog({
      title: T("出金 — Hyperliquid → Arbitrum", "Withdraw — Hyperliquid → Arbitrum"),
      html: T(`出金可能額: <span class="xm-wd">${wd} USDC</span><br>最小 ${MIN_WITHDRAW} USDC・手数料 ${WITHDRAW_FEE} USDC（出金額から差し引き）${spotHint}`,
        `Withdrawable: <span class="xm-wd">${wd} USDC</span><br>Min ${MIN_WITHDRAW} USDC · fee ${WITHDRAW_FEE} USDC (deducted from amount)${spotHint}`),
      input: wd > 0 ? String(wd) : "",
      okLabel: T("次へ", "Next"),
    });
    if (amtIn === null) return;
    const amount = Math.round(parsePositive(amtIn, T("出金額", "amount")) * 1e6) / 1e6; // USDC は 6 decimals
    if (amount < MIN_WITHDRAW) throw new Error(T(`最小出金額は ${MIN_WITHDRAW} USDC です`, `Minimum withdrawal is ${MIN_WITHDRAW} USDC`));
    if (amount - wd > 1e-9) throw new Error(T(`出金額 ${amount} USDC が出金可能額（${wd} USDC）を上回っています`, `Withdraw amount ${amount} USDC exceeds the withdrawable balance (${wd} USDC)`));

    // 出金先は接続中のウォレット固定（手入力可にすると宛先タイポ=資金消失のリスクがあるため
    // 書き換え不可 — ユーザー指示 2026-07-22。別アドレスへ送りたい場合は着金後に Arbitrum 上で送金する）
    const dest = state.user;

    const okc = await xferDialog({
      title: T("出金の確認", "Confirm withdrawal"),
      html: (NET.isMainnet ? `<div class="xm-danger">${T("【Mainnet — 実資金】", "[Mainnet — real funds]")}</div>` : "")
        + T(`<b>${amount} USDC</b> を自分のアドレスへ出金します<br><span class="xm-addr">${dest}</span><br>着金 ${HLSign.floatToWire(amount - WITHDRAW_FEE)} USDC・3〜7分`,
            `Withdraw <b>${amount} USDC</b> to your own address<br><span class="xm-addr">${dest}</span><br>You receive ${HLSign.floatToWire(amount - WITHDRAW_FEE)} USDC · 3–7 min`),
      okLabel: T("出金する", "Withdraw"),
    });
    if (!okc) return;

    trade.busy = true;
    const chainIdHex = await ensureWalletChain();
    tradeStatus(T("MetaMask で出金の署名待ち…", "Waiting for MetaMask signature…"));
    const time = Date.now();
    const action = {
      type: "withdraw3",
      signatureChainId: chainIdHex,
      hyperliquidChain: NET.isMainnet ? "Mainnet" : "Testnet",
      destination: dest,
      amount: HLSign.floatToWire(amount),
      time,
    };
    const typed = HLSign.userSignedTypedData("HyperliquidTransaction:Withdraw", HLSign.WITHDRAW_SIGN_TYPES, action);
    const sigHex = await mmProvider.request({
      method: "eth_signTypedData_v4",
      params: [state.user, JSON.stringify(typed)],
    });
    tradeStatus(T("出金を送信中…", "Submitting withdrawal…"));
    await exchangePost(action, HLSign.splitSig(sigHex), time); // user-signed は nonce = time
    tradeStatus(T(`出金リクエストを送信しました（${amount} USDC → Arbitrum、3〜7分で着金）`, `Withdrawal submitted (${amount} USDC → Arbitrum, arrives in 3–7 min)`), "ok");
    refreshAccount();
  } catch (e) {
    console.error("withdraw:", e);
    tradeStatus(errMsg(e), "err");
    alert(T("出金に失敗:\n", "Withdrawal failed:\n") + errMsg(e)); // 共有 footer からの操作はステータス行が目に入りにくい
  } finally {
    trade.busy = false;
  }
}

// Spot⇄Perps の USDC 振替（user-signed `usdClassTransfer`。手数料なし・即時・自分の口座内移動）。
// 現行の Hyperliquid は入金が Spot に着金するため、Perps で発注/出金するにはこの振替が必要。
// 署名バイト互換は復元アドレス法で testnet 実サーバー照合済み（2026-07-22）
async function transferFunds() {
  if (trade.busy || !xferReady()) return;
  try {
    const spotUsdc = state.spotUsdc ?? 0;
    const wd = state.withdrawable || 0;
    const defToPerp = spotUsdc >= wd; // 残高の多い側から移す方向を既定に
    const dirSel = `<select id="xm-dir">
      <option value="toPerp"${defToPerp ? " selected" : ""}>Spot → Perps</option>
      <option value="toSpot"${defToPerp ? "" : " selected"}>Perps → Spot</option>
    </select>`;
    const dlg = xferDialog({
      title: T("振替 — Spot ⇄ Perps", "Transfer — Spot ⇄ Perps"),
      html: T(`Spot USDC: <b>${spotUsdc}</b> / Perps 出金可能: <b>${wd}</b><br>方向: ${dirSel}<br>手数料なし・即時反映（自分の口座内の移動）`,
        `Spot USDC: <b>${spotUsdc}</b> / perps withdrawable: <b>${wd}</b><br>Direction: ${dirSel}<br>No fee · instant (moves within your own account)`),
      input: String(defToPerp ? spotUsdc : wd),
      okLabel: T("次へ", "Next"),
    });
    // 方向を切り替えたら金額の既定値もその側の全額に追従させる（xferDialog が innerHTML を
    // 同期的に設定してから await するので、ここで select を掴める）
    const dirEl = $("xm-dir");
    dirEl.onchange = () => { $("xm-input").value = String(dirEl.value === "toPerp" ? spotUsdc : wd); };
    const amtIn = await dlg;
    if (amtIn === null) return;
    const toPerp = dirEl.value === "toPerp";
    const cap = toPerp ? spotUsdc : wd;
    const amount = Math.round(parsePositive(amtIn, T("振替額", "amount")) * 1e6) / 1e6; // USDC は 6 decimals
    if (amount - cap > 1e-9) throw new Error(toPerp
      ? T(`振替額 ${amount} USDC が Spot の USDC 残高（${spotUsdc}）を上回っています`, `Transfer amount ${amount} USDC exceeds the spot USDC balance (${spotUsdc})`)
      : T(`振替額 ${amount} USDC が Perps の出金可能額（${wd}）を上回っています`, `Transfer amount ${amount} USDC exceeds the perps withdrawable balance (${wd})`));

    const okc = await xferDialog({
      title: T("振替の確認", "Confirm transfer"),
      html: T(`<b>${amount} USDC</b> を ${toPerp ? "Spot → Perps" : "Perps → Spot"} へ振替します<br>手数料なし・即時反映（口座外への移動はありません）`,
        `Transfer <b>${amount} USDC</b> ${toPerp ? "spot → perps" : "perps → spot"}<br>No fee · instant (funds never leave your account)`),
      okLabel: T("振替する", "Transfer"),
    });
    if (!okc) return;

    trade.busy = true;
    const chainIdHex = await ensureWalletChain();
    tradeStatus(T("MetaMask で振替の署名待ち…", "Waiting for MetaMask signature…"));
    const nonce = Date.now();
    const action = {
      type: "usdClassTransfer",
      signatureChainId: chainIdHex,
      hyperliquidChain: NET.isMainnet ? "Mainnet" : "Testnet",
      amount: HLSign.floatToWire(amount),
      toPerp,
      nonce,
    };
    const typed = HLSign.userSignedTypedData("HyperliquidTransaction:UsdClassTransfer", HLSign.USD_CLASS_TRANSFER_SIGN_TYPES, action);
    const sigHex = await mmProvider.request({
      method: "eth_signTypedData_v4",
      params: [state.user, JSON.stringify(typed)],
    });
    tradeStatus(T("振替を送信中…", "Submitting transfer…"));
    await exchangePost(action, HLSign.splitSig(sigHex), nonce); // user-signed は nonce = action.nonce
    tradeStatus(T(`振替しました（${amount} USDC ${toPerp ? "Spot → Perps" : "Perps → Spot"}）`,
      `Transferred ${amount} USDC ${toPerp ? "spot → perps" : "perps → spot"}`), "ok");
    refreshAccount();
  } catch (e) {
    console.error("transfer:", e);
    tradeStatus(errMsg(e), "err");
    alert(T("振替に失敗:\n", "Transfer failed:\n") + errMsg(e)); // 共有 footer からの操作はステータス行が目に入りにくい
  } finally {
    trade.busy = false;
  }
}

async function depositFunds() {
  if (trade.busy || !xferReady()) return;
  const B = NET.isMainnet ? BRIDGE.mainnet : BRIDGE.testnet;
  try {
    trade.busy = true;
    // MetaMask を Arbitrum へ（違うチェーンのままだと別チェーンの同アドレス宛て送金になり危険）
    await ensureWalletChain();
    // ウォレットの USDC 残高（取れなければ表示だけ省く）
    let bal = null;
    try {
      const data = "0x70a08231" + state.user.slice(2).toLowerCase().padStart(64, "0"); // balanceOf(address)
      const res = await mmProvider.request({ method: "eth_call", params: [{ to: B.usdc, data }, "latest"] });
      bal = Number(BigInt(res)) / 1e6;
    } catch (e) { console.warn("USDC balanceOf:", e); }

    const amtIn = await xferDialog({
      title: T("入金 — Arbitrum → Hyperliquid", "Deposit — Arbitrum → Hyperliquid"),
      html: T(`ウォレット残高: <b>${bal != null ? bal + " USDC" : "取得できず"}</b><br><span class="xm-danger">最小 ${MIN_DEPOSIT} USDC — 未満の入金は没収されます</span>（native USDC のみ）`,
        `Wallet balance: <b>${bal != null ? bal + " USDC" : "unavailable"}</b><br><span class="xm-danger">Min ${MIN_DEPOSIT} USDC — smaller deposits are forfeited</span> (native USDC only)`),
      input: "",
      okLabel: T("次へ", "Next"),
    });
    if (amtIn === null) return;
    const amount = Math.round(parsePositive(amtIn, T("入金額", "amount")) * 1e6) / 1e6; // USDC は 6 decimals
    if (amount < MIN_DEPOSIT) throw new Error(T(`最小入金額は ${MIN_DEPOSIT} USDC です（未満はブリッジに没収されます）`, `Minimum deposit is ${MIN_DEPOSIT} USDC (smaller amounts are forfeited)`));
    if (bal != null && amount - bal > 1e-9) throw new Error(T(`ウォレットの USDC 残高（${bal}）を超えています`, `Exceeds wallet USDC balance (${bal})`));

    const okc = await xferDialog({
      title: T("入金の確認", "Confirm deposit"),
      html: (NET.isMainnet ? `<div class="xm-danger">${T("【Mainnet — 実資金】", "[Mainnet — real funds]")}</div>` : "")
        + T(`${B.chainName} の <b>${amount} USDC</b> を Hyperliquid ブリッジへ送金します<br><span class="xm-addr">${B.bridge}</span><br>約1分で残高に反映されます`,
            `Send <b>${amount} USDC</b> on ${B.chainName} to the Hyperliquid bridge<br><span class="xm-addr">${B.bridge}</span><br>Credited in about 1 minute`),
      okLabel: T("入金する", "Deposit"),
    });
    if (!okc) return;

    tradeStatus(T("MetaMask で送金の承認待ち…", "Waiting for MetaMask confirmation…"));
    const units = BigInt(Math.round(amount * 1e6)); // USDC は 6 decimals
    const calldata = new ethers.Interface(["function transfer(address to, uint256 value) returns (bool)"])
      .encodeFunctionData("transfer", [ethers.getAddress(B.bridge), units]);
    const txHash = await mmProvider.request({
      method: "eth_sendTransaction",
      params: [{ from: state.user, to: ethers.getAddress(B.usdc), data: calldata }],
    });
    tradeStatus(T(`入金トランザクションを送信しました（${txHash.slice(0, 12)}…）。約1分で残高に反映されます`, `Deposit transaction sent (${txHash.slice(0, 12)}…). Credited in about 1 minute`), "ok");
  } catch (e) {
    console.error("deposit:", e);
    tradeStatus(errMsg(e), "err");
    alert(T("入金に失敗:\n", "Deposit failed:\n") + errMsg(e));
  } finally {
    trade.busy = false;
  }
}

function handleAgentError(e) {
  if (/does not exist|not registered|api wallet/i.test(String(e?.message ?? e))) {
    dropAgent();
    renderTradePane();
  }
}

// ---------- UI ----------

function tradeStatus(msg, cls) {
  const el = $("tf-status");
  el.textContent = msg;
  el.className = cls || "";
}

function renderTradePane() {
  const form = $("trade-form");
  const gate = $("trade-gate");
  $("trade-net").textContent = NET.isMainnet ? "Mainnet" : "Testnet";
  $("tf-coin").textContent = state.coin;

  if (tradeReady()) {
    form.hidden = false;
    gate.hidden = true;
    updateSubmitButton();
    return;
  }
  form.hidden = true;
  gate.hidden = false;
  const msg = $("tg-msg");
  const btn = $("tg-btn");
  if (!state.user) {
    // 2画面時の接続ボタンは duo.html 最上段の Connect に一本化（ユーザー要望 2026-07-15。
    // ペイン内には案内文だけ残す — 接続は共有なのでどこで繋いでも両ペインに反映される）
    msg.textContent = FRAMED
      ? T("発注にはウォレット接続が必要です。最上段の Connect から接続してください。", "Connect a wallet to trade — use the Connect button at the top.")
      : T("発注にはウォレット接続が必要です。", "Connect a wallet to place orders.");
    btn.textContent = T("ウォレット接続", "Connect Wallet");
    btn.onclick = openModal;
    btn.hidden = FRAMED;
  } else if (state.userSource !== "mm") {
    msg.textContent = T("ウォッチモードでは発注できません。MetaMask で接続してください。", "Watch mode cannot place orders. Connect with MetaMask.");
    btn.hidden = true;
  } else {
    msg.textContent = T(`MetaMask の署名で API ウォレット（agent 鍵）を承認すると発注できます。承認後の注文はワンクリックで送信されます（${NET.isMainnet ? "Mainnet・実資金" : "Testnet"}）。`,
      `Approve an API wallet (agent key) with a MetaMask signature to enable trading. Orders are then sent with one click (${NET.isMainnet ? "Mainnet — real funds" : "Testnet"}).`);
    btn.textContent = T("取引を有効化", "Enable trading");
    btn.onclick = enableTrading;
    btn.hidden = false;
  }
}

function updateSubmitButton() {
  const btn = $("tf-submit");
  const isBuy = trade.side === "buy";
  btn.textContent = T(`${state.coin} を${isBuy ? "買う" : "売る"}${trade.type === "market" ? "（成行）" : ""}`,
    `${isBuy ? "Buy" : "Sell"} ${state.coin}${trade.type === "market" ? " (market)" : ""}`);
  btn.className = isBuy ? "buy" : "sell";
  $("tf-px").disabled = trade.type === "market";
  // framed ペインではラベル列を隠し placeholder がラベル代わり（1画面ではラベルと重複するため 0.0）
  $("tf-px").placeholder = trade.type === "market" ? T("成行", "Market") : FRAMED ? T("価格", "Price") : "0.0";
  updateNotional();
}

function updateNotional() {
  const sz = Number($("tf-sz").value);
  const px = trade.type === "market" ? state.markPx : Number($("tf-px").value);
  const el = $("tf-notional");
  el.textContent = sz > 0 && px > 0 ? "≈ " + fmtUsd2(sz * px) : "";
}

// app.js から呼ばれるフック
function tradeOnUser() {
  trade.agent = state.user && state.userSource === "mm" ? loadAgent() : null;
  renderTradePane();
  refreshLeverage();
}

function tradeOnCoinChange() {
  $("tf-coin").textContent = state.coin;
  $("tf-px").value = "";
  updateSubmitButton();
  refreshLeverage();
}

// --- event wiring ---

for (const btn of document.querySelectorAll("#tf-side button")) {
  btn.addEventListener("click", () => {
    document.querySelector("#tf-side .active")?.classList.remove("active");
    btn.classList.add("active");
    trade.side = btn.dataset.side;
    updateSubmitButton();
  });
}

for (const btn of document.querySelectorAll("#tf-type button")) {
  btn.addEventListener("click", () => {
    document.querySelector("#tf-type .active")?.classList.remove("active");
    btn.classList.add("active");
    trade.type = btn.dataset.type;
    if (trade.type === "limit" && !$("tf-px").value && state.markPx > 0) {
      $("tf-px").value = String(state.markPx);
    }
    updateSubmitButton();
  });
}

if (!FRAMED) { $("tf-px").placeholder = "0.0"; $("tf-sz").placeholder = "0.0"; } // 1画面ではラベル列があるため
$("tf-px").addEventListener("input", updateNotional);
$("tf-sz").addEventListener("input", updateNotional);
$("tf-submit").addEventListener("click", submitOrder);

for (const btn of document.querySelectorAll("#tf-margin button")) {
  btn.addEventListener("click", () => setMarginMode(btn.dataset.mode === "cross"));
}
$("tf-lev-set").addEventListener("click", setLeverage);

// 注文・ポジションテーブルのボタン（動的生成のため委譲）。2画面時のテーブルは
// duo.html の共有 footer にあり、処理するのは供給役（左ペイン）だけ。ペイン再読込で
// 親ドキュメントに古いリスナーが積み重ならないよう addEventListener でなく onclick 代入
if (ACCT_ON) {
  acct("orders").onclick = (e) => {
    const cxl = e.target.closest("button.cxl");
    if (cxl) { cancelOrder(cxl.dataset.coin, Number(cxl.dataset.oid)); return; }
    const mod = e.target.closest("button.mod");
    if (mod) modifyOrder(Number(mod.dataset.oid));
  };

  acct("positions").onclick = (e) => {
    const btn = e.target.closest("button.close-pos");
    if (btn) closePosition(btn.dataset.coin);
  };

  // 入出金・振替（共有 footer のボタンも供給役ペインが処理。onclick 代入は上と同じ理由）
  const dep = acct("ac-deposit"), wdb = acct("ac-withdraw-btn"), trf = acct("ac-transfer");
  if (dep) dep.onclick = depositFunds;
  if (wdb) wdb.onclick = withdrawFunds;
  if (trf) trf.onclick = transferFunds;
}

renderTradePane();
