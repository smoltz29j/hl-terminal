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
  if (!(state.markPx > 0)) throw new Error("mark 価格が未取得です");
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
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label}が不正です: 「${s}」`);
  return n;
}

// ---------- 取引の有効化（approveAgent） ----------

async function enableTrading() {
  const btn = $("tg-btn");
  btn.disabled = true;
  try {
    tradeStatus("MetaMask で承認待ち…");
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
    tradeStatus("承認を送信中…");
    await exchangePost(action, HLSign.splitSig(sigHex), nonce);
    localStorage.setItem(agentStoreKey(state.user), JSON.stringify({
      key: agent.privateKey, address: agent.address, name: AGENT_NAME, approvedAt: Date.now(),
    }));
    trade.agent = agent;
    tradeStatus("取引を有効化しました", "ok");
    renderTradePane();
    refreshAccount();
  } catch (e) {
    console.error("approveAgent:", e);
    tradeStatus(errMsg(e), "err");
  } finally {
    btn.disabled = false;
  }
}

function errMsg(e) {
  const m = String(e?.message ?? e);
  if (/must deposit/i.test(m)) return `このアカウントは ${NET.isMainnet ? "mainnet" : "testnet"} に入金がありません`;
  if (/user rejected|denied/i.test(m)) return "署名がキャンセルされました";
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
    if (asset == null) throw new Error("この銘柄は発注に未対応です");
    const sz = Number(parsePositive($("tf-sz").value, "数量").toFixed(szd));
    if (sz <= 0) throw new Error(`数量が最小単位（${Math.pow(10, -szd)}）未満です`);
    let px, tif;
    if (trade.type === "market") { px = slippagePx(isBuy, szd); tif = "Ioc"; }
    else { px = parsePositive($("tf-px").value, "価格"); tif = "Gtc"; }

    const label = `${coin} ${isBuy ? "買い" : "売り"} ${sz} @ ${trade.type === "market" ? "成行" : px}`;
    if (NET.isMainnet && !confirm(`【Mainnet — 実資金】\n${label}\n送信しますか？`)) return;

    trade.busy = true;
    $("tf-submit").disabled = true;
    tradeStatus("送信中…");

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
    if (st.filled) tradeStatus(`約定: ${st.filled.totalSz} @ ${st.filled.avgPx}`, "ok");
    else if (st.resting) tradeStatus(`板に登録（oid ${st.resting.oid}）`, "ok");
    else tradeStatus("送信しました", "ok");
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
    tradeStatus(`キャンセルしました（oid ${oid}）`, "ok");
    refreshAccount();
  } catch (e) {
    console.error("cancel:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
    alert("キャンセルに失敗:\n" + errMsg(e));
  }
}

// 既存指値の価格・数量を変更（batchModify）。tif / reduceOnly は元の注文から引き継ぐ
async function modifyOrder(oid) {
  if (!tradeReady()) return;
  const o = state.openOrders.find((x) => x.oid === oid);
  if (!o) { tradeStatus("注文が見つかりません（更新直後の可能性）", "err"); return; }
  try {
    const pxIn = prompt(`${o.coin} ${o.side === "B" ? "買い" : "売り"} の新しい価格:`, o.limitPx);
    if (pxIn === null) return;
    const szIn = prompt("新しい数量:", o.sz);
    if (szIn === null) return;
    const px = parsePositive(pxIn, "価格");
    const szd = state.szDecimals[o.coin] ?? 0;
    const sz = Number(parsePositive(szIn, "数量").toFixed(szd));
    if (sz <= 0) throw new Error(`数量が最小単位（${Math.pow(10, -szd)}）未満です`);

    if (NET.isMainnet && !confirm(`【Mainnet — 実資金】\n${o.coin} 注文 ${oid} を修正:\n${o.limitPx} → ${px} / ${o.sz} → ${sz}\n送信しますか？`)) return;

    tradeStatus("修正を送信中…");
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
    tradeStatus(`修正しました（oid ${st.resting?.oid ?? oid}）`, "ok");
    refreshAccount();
  } catch (e) {
    console.error("modify:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
    alert("注文修正に失敗:\n" + errMsg(e)); // テーブル操作はステータス行が目に入りにくいため明示
  }
}

// ポジションをクローズ（Reduce Only）。数量指定で部分クローズ、価格指定で指値クローズ可
async function closePosition(coin) {
  if (!tradeReady()) return;
  const p = state.positions.find((x) => x.coin === coin);
  if (!p) { tradeStatus("ポジションが見つかりません", "err"); return; }
  try {
    const szi = Number(p.szi);
    const isBuy = szi < 0; // ショートは買い戻し、ロングは売り
    const maxSz = Math.abs(szi);
    const asset = state.assetIds[coin];
    if (asset == null) throw new Error("この銘柄はクローズ操作に未対応です");
    const szd = state.szDecimals[coin] ?? 0;

    const szIn = prompt(`${coin} のクローズ数量（最大 ${maxSz}）:`, maxSz);
    if (szIn === null) return;
    const sz = Number(parsePositive(szIn, "数量").toFixed(szd));
    if (sz - maxSz > 1e-12) throw new Error(`ポジションサイズ（${maxSz}）を超えています`);

    const pxIn = prompt("指値価格（空欄なら成行）:", "");
    if (pxIn === null) return;
    let px, tif, kind;
    if (pxIn.trim() === "") {
      // 成行 = IOC。mark はポジションの値から算出（チャート表示外の銘柄でも取れる）
      const mark = Number(p.positionValue) / maxSz;
      if (!(mark > 0)) throw new Error("mark 価格を取得できません");
      px = mark * (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE);
      px = Number(px.toPrecision(5));
      px = Number(px.toFixed(Math.max(0, 6 - szd)));
      tif = "Ioc";
      kind = "成行";
    } else {
      px = parsePositive(pxIn, "価格");
      tif = "Gtc";
      kind = `指値 ${px}`;
    }

    if (!confirm(`${NET.isMainnet ? "【Mainnet — 実資金】\n" : ""}${coin} ポジション ${p.szi} のうち ${sz} を${kind}でクローズしますか？`)) return;

    tradeStatus("クローズを送信中…");
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
    if (st.filled) tradeStatus(`クローズ約定: ${st.filled.totalSz} @ ${st.filled.avgPx}`, "ok");
    else if (st.resting) tradeStatus(`クローズ指値を板に登録（oid ${st.resting.oid}）`, "ok");
    else tradeStatus("クローズ注文を送信しました", "ok");
    refreshAccount();
  } catch (e) {
    console.error("close:", e);
    handleAgentError(e);
    tradeStatus(errMsg(e), "err");
    alert("クローズに失敗:\n" + errMsg(e));
  }
}

// agent 鍵が失効/未承認になっていたら破棄して再有効化を促す
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
    msg.textContent = "発注にはウォレット接続が必要です。";
    btn.textContent = "ウォレット接続";
    btn.onclick = openModal;
    btn.hidden = false;
  } else if (state.userSource !== "mm") {
    msg.textContent = "ウォッチモードでは発注できません。MetaMask で接続してください。";
    btn.hidden = true;
  } else {
    msg.textContent = `MetaMask の署名で API ウォレット（agent 鍵）を承認すると発注できます。承認後の注文はワンクリックで送信されます（${NET.isMainnet ? "Mainnet・実資金" : "Testnet"}）。`;
    btn.textContent = "取引を有効化";
    btn.onclick = enableTrading;
    btn.hidden = false;
  }
}

function updateSubmitButton() {
  const btn = $("tf-submit");
  const isBuy = trade.side === "buy";
  btn.textContent = `${state.coin} を${isBuy ? "買う" : "売る"}${trade.type === "market" ? "（成行）" : ""}`;
  btn.className = isBuy ? "buy" : "sell";
  $("tf-px").disabled = trade.type === "market";
  $("tf-px").placeholder = trade.type === "market" ? "成行" : "0.0";
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
}

function tradeOnCoinChange() {
  $("tf-coin").textContent = state.coin;
  $("tf-px").value = "";
  updateSubmitButton();
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

$("tf-px").addEventListener("input", updateNotional);
$("tf-sz").addEventListener("input", updateNotional);
$("tf-submit").addEventListener("click", submitOrder);

// 注文・ポジションテーブルのボタン（動的生成のため委譲）
$("orders").addEventListener("click", (e) => {
  const cxl = e.target.closest("button.cxl");
  if (cxl) { cancelOrder(cxl.dataset.coin, Number(cxl.dataset.oid)); return; }
  const mod = e.target.closest("button.mod");
  if (mod) modifyOrder(Number(mod.dataset.oid));
});

$("positions").addEventListener("click", (e) => {
  const btn = e.target.closest("button.close-pos");
  if (btn) closePosition(btn.dataset.coin);
});

renderTradePane();
