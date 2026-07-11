"use strict";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const WS_URL = "wss://api.hyperliquid.xyz/ws";

const IV_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
const BOOK_LEVELS = 11;
const MAX_TRADES = 60;
const CANDLE_BARS = 300;

// lightweight-charts labels the time scale in UTC; shift epochs so labels read as local time
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;

const state = {
  coin: "BTC",
  interval: "5m",
  ws: null,
  wsReady: false,
  reconnectDelay: 1000,
  szDecimals: {},        // coin -> size decimals
  pxDecimals: 1,         // decimals of the current coin's prices (derived from data)
  lastCandleT: 0,
  user: null,            // connected/watched wallet address
  acctTimer: null,
};

const $ = (id) => document.getElementById(id);

// ---------- formatting ----------

function fmtNum(x, maxFrac = 2) {
  return Number(x).toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

function fmtPx(x) {
  return Number(x).toLocaleString("en-US", {
    minimumFractionDigits: state.pxDecimals,
    maximumFractionDigits: state.pxDecimals,
  });
}

function fmtUsd(x) {
  const n = Number(x);
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + n.toFixed(0);
}

function decimalsOf(s) {
  const i = String(s).indexOf(".");
  return i < 0 ? 0 : String(s).length - i - 1;
}

// ---------- REST ----------

async function info(body) {
  const r = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`info ${body.type}: HTTP ${r.status}`);
  return r.json();
}

async function loadCoins() {
  const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" });
  const coins = meta.universe
    .map((u, i) => ({ ...u, ctx: ctxs[i] }))
    .filter((u) => !u.isDelisted)
    .sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm));
  const sel = $("coin-select");
  sel.innerHTML = "";
  for (const c of coins) {
    state.szDecimals[c.name] = c.szDecimals;
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = `${c.name}-PERP`;
    sel.appendChild(opt);
  }
  sel.value = state.coin;
}

// ---------- chart ----------

let chart, candleSeries, volumeSeries;

function setupChart() {
  chart = LightweightCharts.createChart($("chart"), {
    layout: { background: { color: "#0d0d0d" }, textColor: "#898781" },
    grid: {
      vertLines: { color: "#2c2c2a" },
      horzLines: { color: "#2c2c2a" },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: "#383835",
      rightOffset: 5,
      shiftVisibleRangeOnNewBar: true,
    },
    rightPriceScale: { borderColor: "#383835" },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#0ca30c", downColor: "#e66767",
    wickUpColor: "#0ca30c", wickDownColor: "#e66767",
    borderVisible: false,
  });
  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "vol",
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  new ResizeObserver(() => {
    const el = $("chart");
    chart.resize(el.clientWidth, el.clientHeight);
  }).observe($("chart"));
}

function candlePoint(k) {
  return {
    time: k.t / 1000 + TZ_SHIFT,
    open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
  };
}

function volumePoint(k) {
  const up = Number(k.c) >= Number(k.o);
  return {
    time: k.t / 1000 + TZ_SHIFT,
    value: Number(k.v),
    color: up ? "rgba(12,163,12,0.35)" : "rgba(230,103,103,0.35)",
  };
}

async function loadCandles() {
  const end = Date.now();
  const start = end - CANDLE_BARS * IV_MS[state.interval];
  const ks = await info({
    type: "candleSnapshot",
    req: { coin: state.coin, interval: state.interval, startTime: start, endTime: end },
  });
  state.pxDecimals = Math.max(0, ...ks.slice(-50).map((k) => decimalsOf(k.c)));
  candleSeries.applyOptions({
    priceFormat: { type: "price", precision: state.pxDecimals, minMove: Math.pow(10, -state.pxDecimals) },
  });
  candleSeries.setData(ks.map(candlePoint));
  volumeSeries.setData(ks.map(volumePoint));
  state.lastCandleT = ks.length ? ks[ks.length - 1].t : 0;
  // 全300本を収めると1本が数pxになり足の更新が見えないため、直近約80本を表示
  // （最終バーの論理位置は ks.length-1。右余白は rightOffset と同じ5本に揃える）
  chart.timeScale().setVisibleLogicalRange({ from: ks.length - 81, to: ks.length + 4 });
}

// ---------- order book ----------

function renderBook(data) {
  const [bids, asks] = data.levels;
  const b = bids.slice(0, BOOK_LEVELS);
  const a = asks.slice(0, BOOK_LEVELS);
  let cum = 0;
  const bcum = b.map((l) => (cum += Number(l.sz)));
  cum = 0;
  const acum = a.map((l) => (cum += Number(l.sz)));
  const maxCum = Math.max(bcum[bcum.length - 1] || 0, acum[acum.length - 1] || 0) || 1;
  const szd = state.szDecimals[state.coin] ?? 2;

  const rowHtml = (l, c, side) =>
    `<div class="row depth ${side}" style="--depth:${((c / maxCum) * 100).toFixed(1)}%">` +
    `<span class="px ${side === "ask" ? "sell" : "buy"}">${fmtPx(l.px)}</span>` +
    `<span>${fmtNum(l.sz, szd)}</span><span>${fmtNum(c, szd)}</span></div>`;

  // asks: best at bottom (adjacent to spread)
  $("asks").innerHTML = a.map((l, i) => rowHtml(l, acum[i], "ask")).reverse().join("");
  $("bids").innerHTML = b.map((l, i) => rowHtml(l, bcum[i], "bid")).join("");

  if (b.length && a.length) {
    const spread = Number(a[0].px) - Number(b[0].px);
    const mid = (Number(a[0].px) + Number(b[0].px)) / 2;
    $("spread-val").innerHTML =
      `<span class="label">Spread</span>${fmtNum(spread, state.pxDecimals + 1)} (${((spread / mid) * 10000).toFixed(1)} bp)`;
  }
}

// ---------- trades ----------

function renderTrades(trades) {
  const el = $("trades");
  const szd = state.szDecimals[state.coin] ?? 2;
  const html = trades
    .slice()
    .reverse()
    .map((t) => {
      const side = t.side === "B" ? "buy" : "sell";
      const time = new Date(t.time).toLocaleTimeString("ja-JP", { hour12: false });
      return `<div class="row"><span class="px ${side}">${fmtPx(t.px)}</span>` +
        `<span>${fmtNum(t.sz, szd)}</span><span>${time}</span></div>`;
    })
    .join("");
  el.insertAdjacentHTML("afterbegin", html);
  while (el.childElementCount > MAX_TRADES) el.lastElementChild.remove();
}

// ---------- stats ----------

function renderStats(ctx) {
  const mark = Number(ctx.markPx);
  const prev = Number(ctx.prevDayPx);
  const chg = prev ? ((mark - prev) / prev) * 100 : 0;
  const funding = Number(ctx.funding) * 100;

  $("st-mark").textContent = fmtPx(mark);
  const chEl = $("st-change");
  chEl.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
  chEl.className = "value " + (chg >= 0 ? "up" : "down");
  const fEl = $("st-funding");
  fEl.textContent = (funding >= 0 ? "+" : "") + funding.toFixed(4) + "%";
  fEl.className = "value " + (funding >= 0 ? "up" : "down");
  $("st-oi").textContent = fmtUsd(Number(ctx.openInterest) * mark);
  $("st-vol").textContent = fmtUsd(ctx.dayNtlVlm);
  document.title = `${fmtPx(mark)} ${state.coin} · HL Terminal`;
}

// ---------- websocket ----------

function subs(coin, interval) {
  return [
    { type: "l2Book", coin },
    { type: "trades", coin },
    { type: "candle", coin, interval },
    { type: "activeAssetCtx", coin },
  ];
}

function wsSend(method, subscription) {
  if (state.wsReady) state.ws.send(JSON.stringify({ method, subscription }));
}

function connect() {
  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.onopen = () => {
    state.wsReady = true;
    state.reconnectDelay = 1000;
    $("conn").className = "up";
    for (const s of subs(state.coin, state.interval)) wsSend("subscribe", s);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.channel) {
      case "l2Book":
        if (msg.data.coin === state.coin) renderBook(msg.data);
        break;
      case "trades": {
        const ours = msg.data.filter((t) => t.coin === state.coin);
        if (ours.length) renderTrades(ours);
        break;
      }
      case "candle": {
        const k = msg.data;
        if (k.s === state.coin && k.i === state.interval && k.t >= state.lastCandleT) {
          const isNewBar = k.t > state.lastCandleT;
          state.lastCandleT = k.t;
          candleSeries.update(candlePoint(k));
          volumeSeries.update(volumePoint(k));
          // 足が切り替わったら右端へ追従（過去を見るためスクロール中は追従しない）
          if (isNewBar && chart.timeScale().scrollPosition() > -3) {
            chart.timeScale().scrollToRealTime();
          }
        }
        break;
      }
      case "activeAssetCtx":
        if (msg.data.coin === state.coin) renderStats(msg.data.ctx);
        break;
    }
  };

  ws.onclose = () => {
    state.wsReady = false;
    $("conn").className = "down";
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  };
  ws.onerror = () => ws.close();
}

setInterval(() => {
  if (state.wsReady) state.ws.send(JSON.stringify({ method: "ping" }));
}, 45000);

// ---------- wallet / account ----------

function fmtUsd2(x) {
  const n = Number(x);
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "-$" : "$") + s;
}

function fmtAnyPx(x) {
  return Number(x).toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

function signCls(n) { return Number(n) >= 0 ? "up" : "down"; }

async function refreshAccount() {
  if (!state.user) return;
  const user = state.user;
  try {
    const [ch, orders] = await Promise.all([
      info({ type: "clearinghouseState", user }),
      info({ type: "openOrders", user }),
    ]);
    if (user !== state.user) return; // switched/disconnected while in flight
    renderAccount(ch, orders);
  } catch (e) {
    console.error("account refresh failed:", e);
  }
}

function renderAccount(ch, orders) {
  const positions = ch.assetPositions.map((p) => p.position);
  const upnl = positions.reduce((s, p) => s + Number(p.unrealizedPnl), 0);

  $("ac-equity").textContent = fmtUsd2(ch.marginSummary.accountValue);
  $("ac-withdraw").textContent = fmtUsd2(ch.withdrawable);
  $("ac-margin").textContent = fmtUsd2(ch.marginSummary.totalMarginUsed);
  const upEl = $("ac-upnl");
  upEl.textContent = (upnl >= 0 ? "+" : "") + fmtUsd2(upnl);
  upEl.className = "value " + signCls(upnl);

  $("positions").tBodies[0].innerHTML = positions.length
    ? positions.map((p) => {
        const sz = Number(p.szi);
        const mark = Math.abs(sz) > 0 ? Number(p.positionValue) / Math.abs(sz) : 0;
        const roe = (Number(p.returnOnEquity) * 100).toFixed(1);
        return `<tr>
          <td class="coin">${p.coin} <span class="tag">${p.leverage.value}x</span></td>
          <td class="${signCls(sz)}">${fmtNum(sz, state.szDecimals[p.coin] ?? 4)}</td>
          <td>${fmtAnyPx(p.entryPx)}</td>
          <td>${fmtAnyPx(mark)}</td>
          <td class="${signCls(p.unrealizedPnl)}">${fmtUsd2(p.unrealizedPnl)} (${roe}%)</td>
          <td>${p.liquidationPx ? fmtAnyPx(p.liquidationPx) : "–"}</td>
          <td>${fmtUsd2(p.marginUsed)}</td>
        </tr>`;
      }).join("")
    : `<tr><td class="empty" colspan="7">ポジションなし</td></tr>`;

  $("orders").tBodies[0].innerHTML = orders.length
    ? orders
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((o) => {
          const side = o.side === "B" ? "buy" : "sell";
          const time = new Date(o.timestamp).toLocaleTimeString("ja-JP", { hour12: false });
          return `<tr>
            <td class="coin">${o.coin}</td>
            <td class="${side}">${o.side === "B" ? "Buy" : "Sell"}</td>
            <td>${fmtAnyPx(o.limitPx)}</td>
            <td>${fmtNum(o.sz, state.szDecimals[o.coin] ?? 4)}</td>
            <td>${o.reduceOnly ? '<span class="tag">RO</span>' : ""}</td>
            <td>${time}</td>
          </tr>`;
        }).join("")
    : `<tr><td class="empty" colspan="6">注文なし</td></tr>`;
}

function setUser(addr) {
  clearInterval(state.acctTimer);
  state.user = addr;
  const btn = $("wallet-btn");
  if (addr) {
    btn.textContent = addr.slice(0, 6) + "…" + addr.slice(-4);
    btn.classList.add("connected");
    btn.title = addr + "（クリックで切断）";
    $("account").hidden = false;
    refreshAccount();
    state.acctTimer = setInterval(refreshAccount, 5000);
  } else {
    btn.textContent = "Connect";
    btn.classList.remove("connected");
    btn.title = "";
    $("account").hidden = true;
  }
}

// --- connect modal ---

let mmsdk = null;
let mmProvider = null;

function openModal() {
  $("connect-modal").hidden = false;
}

function closeModal() {
  $("connect-modal").hidden = true;
}

// MetaMask SDK: 拡張があればそれを使い、無ければ SDK が QR モーダルを表示して
// スマホの MetaMask アプリと本セッションを張る（app.hyperliquid.xyz と同じ方式）
async function connectMetaMask() {
  const btn = $("cm-mm");
  btn.disabled = true;
  btn.textContent = "接続待ち…";
  try {
    if (!mmsdk) {
      mmsdk = new MetaMaskSDK.MetaMaskSDK({
        dappMetadata: { name: "HL Terminal", url: location.origin },
        checkInstallationImmediately: false,
      });
      await mmsdk.init();
    }
    mmProvider = mmsdk.getProvider();
    // request の解決を待たずに済むよう先に登録（承認がスマホ側で遅れて完了した場合の保険）
    mmProvider.removeAllListeners?.("accountsChanged");
    mmProvider.on("accountsChanged", (a) => {
      if (a?.length) { setUser(a[0]); closeModal(); }
      else setUser(null);
    });
    const accounts = await mmProvider.request({ method: "eth_requestAccounts" });
    if (accounts?.length) {
      setUser(accounts[0]);
      closeModal();
    }
  } catch (e) {
    console.error("MetaMask connect:", e);
  } finally {
    btn.disabled = false;
    btn.textContent = "MetaMask で接続";
  }
}

function disconnectWallet() {
  try { mmsdk?.terminate(); } catch { /* no active SDK session */ }
  setUser(null);
}

function connectWatch() {
  const addr = prompt("表示するアドレスを入力（ウォッチモード）:");
  if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr.trim())) {
    setUser(addr.trim().toLowerCase());
    closeModal();
  } else if (addr) {
    alert("アドレスの形式が不正です");
  }
}

$("wallet-btn").addEventListener("click", () => {
  if (state.user) disconnectWallet();
  else openModal();
});
$("cm-close").addEventListener("click", closeModal);
$("connect-modal").addEventListener("click", (e) => { if (e.target.id === "connect-modal") closeModal(); });
$("cm-mm").addEventListener("click", connectMetaMask);
$("cm-watch").addEventListener("click", connectWatch);

// ---------- switching ----------

async function switchTo(coin, interval) {
  for (const s of subs(state.coin, state.interval)) wsSend("unsubscribe", s);
  state.coin = coin;
  state.interval = interval;
  $("asks").innerHTML = $("bids").innerHTML = $("trades").innerHTML = "";
  await loadCandles();
  for (const s of subs(coin, interval)) wsSend("subscribe", s);
}

$("coin-select").addEventListener("change", (e) => switchTo(e.target.value, state.interval));

for (const btn of document.querySelectorAll("#intervals button")) {
  btn.addEventListener("click", () => {
    document.querySelector("#intervals .active")?.classList.remove("active");
    btn.classList.add("active");
    switchTo(state.coin, btn.dataset.iv);
  });
}

// ---------- boot ----------

(async () => {
  setupChart();
  await loadCoins();
  await loadCandles();
  connect();
  const qUser = new URLSearchParams(location.search).get("user");
  if (qUser && /^0x[0-9a-fA-F]{40}$/.test(qUser)) setUser(qUser.toLowerCase());
})();
