"use strict";

// ---------- API 接続先（設定で公式 Mainnet / Testnet / カスタムを切替） ----------

const NETS = {
  mainnet: { label: "Mainnet", http: "https://api.hyperliquid.xyz", ws: "wss://api.hyperliquid.xyz/ws", isMainnet: true },
  testnet: { label: "Testnet", http: "https://api.hyperliquid-testnet.xyz", ws: "wss://api.hyperliquid-testnet.xyz/ws", isMainnet: false },
  // 代替エンドポイントのプリセット（公式障害・レートリミット時のフォールバック用）。
  // どちらも Hyperliquid 運営の別プール。REST 200 + CORS * + WS 接続を 2026-07-14 に確認済み。
  // 鍵が必要な真のサードパーティ（Chainstack/QuickNode 等）はカスタム URL で設定する。
  "api-ui": { label: "API-UI", http: "https://api-ui.hyperliquid.xyz", ws: "wss://api-ui.hyperliquid.xyz/ws", isMainnet: true, alt: true },
  api2: { label: "API2", http: "https://api2.hyperliquid.xyz", ws: "wss://api2.hyperliquid.xyz/ws", isMainnet: true, alt: true },
};

const API_CFG = (() => {
  try { return JSON.parse(localStorage.getItem("hlt-api")) || { mode: "mainnet" }; }
  catch { return { mode: "mainnet" }; }
})();

const NET = (() => {
  if (API_CFG.mode === "custom" && API_CFG.http) {
    const http = API_CFG.http.replace(/\/+$/, "");
    const ws = (API_CFG.ws || "").trim() || http.replace(/^http/, "ws") + "/ws";
    return { label: "Custom", http, ws, isMainnet: API_CFG.mainnet !== false, custom: true };
  }
  return NETS[API_CFG.mode] || NETS.mainnet;
})();

const INFO_URL = NET.http + "/info";
const EXCHANGE_URL = NET.http + "/exchange";
const WS_URL = NET.ws;

// 1M は月の長さが揺れるが、取得範囲の計算と未来延長の目盛りにしか使わないため30日で近似
const IV_MS = { "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3, "1w": 604800e3, "1M": 2592000e3 };
const BOOK_LEVELS = 11;
const MAX_TRADES = 60;
const CANDLE_BARS = 300;

// lightweight-charts labels the time scale in UTC; shift epochs so labels read as local time
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;

const state = {
  coin: "BTC",
  coinList: [],          // 出来高降順の全銘柄名（銘柄ピッカーの候補。builder DEX 銘柄は "xyz:CL" 形式）
  coinLabels: {},        // coin -> 表示名（"BTC-PERP" / "WTIOIL (xyz)" 等）
  interval: "1d",
  ws: null,
  wsReady: false,
  reconnectDelay: 1000,
  lastWsMsg: 0,          // WS 死活監視（最終受信時刻。60秒途絶で作り直す）
  everConnected: false,  // 再接続判定（onopen で欠けた足を REST で取り直すか）
  szDecimals: {},        // coin -> size decimals
  maxLev: {},            // coin -> maxLeverage（レバレッジ変更 UI の上限）
  assetIds: {},          // coin -> asset id（meta.universe の元 index。発注に使用）
  pxDecimals: 1,         // decimals of the current coin's prices (derived from data)
  lastCandleT: 0,
  bookTime: 0,           // 描画済み板の time（WS と REST ポーリングの併用で古い方を捨てる）
  candles: [],           // 現在銘柄・現在足の生ローソク（指標計算用）
  markPx: 0,             // 現在銘柄の mark（成行の基準価格）
  user: null,            // connected/watched wallet address
  userSource: null,      // "mm"（MetaMask 接続）| "watch"
  acctTimer: null,
  openOrders: [],        // frontendOpenOrders の生データ（oid → 注文詳細の参照用）
  positions: [],         // clearinghouseState のポジション（クローズ操作の参照用）
  withdrawable: 0,       // 引き出し可能 USDC（出金 UI のデフォルト値・上限チェック用）
};

// ---------- 2画面モード（duo.html が index.html?pane=1/2 を iframe で並べる） ----------
const PANE = new URLSearchParams(location.search).get("pane");
const FRAMED = window.self !== window.top;

const $ = (id) => document.getElementById(id);

// ---------- 表示言語（JP/EN 切替。既定 JP） ----------
// 動的文字列は T("日本語","English") をインラインで併記する方式（辞書キーの管理を避ける）。
// 静的 HTML は日本語で書き、EN のときだけ applyLang() が差し替える。切替は reload。
const LANG = (() => {
  try { return localStorage.getItem("hlt-lang") === "en" ? "en" : "jp"; }
  catch { return "jp"; }
})();
const T = (ja, en) => (LANG === "en" ? en : ja);

// アカウント欄（Positions / Open Orders）は2画面時は duo.html 下段の共有 footer に
// 1つだけ描画する（ティッカーと同じ「左ペインが供給役」方式）。右ペインは
// ポーリング・描画とも行わず、発注後の更新は左ペインへ依頼する（refreshAccount 参照）
const ACCT_ON = PANE !== "2";
const acct = (id) => (FRAMED ? window.top.document.getElementById(id) : $(id));

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
  // 既定 DEX に加え、HIP-3 builder DEX（xyz 等。perpDexs で列挙）の銘柄もセレクタに載せる。
  // 表示名は perpConciseAnnotations の displayName（例: xyz:CL → WTIOIL）+ DEX 名で区別
  // （同名銘柄が DEX 間に複数ある: xyz:NVDA と flx:NVDA 等）。
  const [dexs, annos] = await Promise.all([
    info({ type: "perpDexs" }).catch(() => [null]),
    info({ type: "perpConciseAnnotations" }).catch(() => []),
  ]);
  const dexNames = (Array.isArray(dexs) ? dexs : [null]).map((d) => d?.name ?? "");
  const metas = await Promise.all(dexNames.map((dex) =>
    info(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }).catch(() => null)
  ));
  const disp = new Map(annos.map(([coin, a]) => [coin, a?.displayName]));

  const coins = [];
  metas.forEach((m, di) => {
    if (!m) return;
    const dex = dexNames[di];
    const [meta, ctxs] = m;
    meta.universe.forEach((u, i) => {
      if (u.isDelisted) return;
      coins.push({
        ...u,
        ctx: ctxs[i],
        // builder DEX の asset id は採番体系が別（100000+ 系）で未検証のため登録しない
        // → 発注時は trade.js の「この銘柄は発注に未対応です」ガードに掛かる（誤発注防止）
        assetId: dex ? null : i,
        label: dex ? `${disp.get(u.name) ?? u.name.split(":")[1] ?? u.name} (${dex})` : `${u.name}-PERP`,
      });
    });
  });
  coins.sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm));

  state.coinList = [];
  state.coinLabels = {};
  for (const c of coins) {
    state.szDecimals[c.name] = c.szDecimals;
    state.maxLev[c.name] = c.maxLeverage;
    if (c.assetId != null) state.assetIds[c.name] = c.assetId;
    state.coinLabels[c.name] = c.label;
    state.coinList.push(c.name);
  }
  // 接続先によっては既定銘柄が無いことがある（testnet 等）→ 出来高最大の銘柄へ
  if (!state.coinList.includes(state.coin)) state.coin = state.coinList[0] ?? state.coin;
  setCoinOptions(state.coinList, state.coin);
}

// プルダウンの option を候補リストで作り直す（selected が候補に無ければ先頭を選択）
function setCoinOptions(names, selected) {
  const sel = $("coin-select");
  sel.innerHTML = "";
  if (!names.length) {
    const opt = document.createElement("option");
    opt.textContent = T("該当なし", "No match");
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    return;
  }
  for (const c of names) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = state.coinLabels[c] ?? `${c}-PERP`;
    sel.appendChild(opt);
  }
  sel.value = names.includes(selected) ? selected : names[0];
}

// ---------- chart ----------

let chart, candleSeries, volChart, volumeSeries;

// ---------- indicators (MA / Bollinger Bands) ----------
// 線色は dataviz palette から選択（相互 + 対ローソクの CVD 分離を検証済み）

const IND_CFG = (() => {
  try { return { ma: true, bb: true, tl: true, ...JSON.parse(localStorage.getItem("hlt-ind") || "{}") }; }
  catch { return { ma: true, bb: true, tl: true }; }
})();

const MA_DEFS = [
  { period: 20, color: "#c98500" },
  { period: 50, color: "#3987e5" },
];
const BB_DEF = { period: 20, mult: 2, color: "#d55181" };

let maSeries = [];        // MA_DEFS と同順
let bbSeries = null;      // { upper, lower }

function addIndicatorSeries() {
  const mkLine = (color, width) => chart.addLineSeries({
    color, lineWidth: width,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    visible: false,
  });
  maSeries = MA_DEFS.map((d) => mkLine(d.color, 2));
  bbSeries = { upper: mkLine(BB_DEF.color, 1), lower: mkLine(BB_DEF.color, 1) };
}

// closes[i-p+1..i] の平均と標準偏差（母標準偏差 = 一般的な BB の定義）
function windowStats(closes, i, p) {
  let sum = 0, sq = 0;
  for (let j = i - p + 1; j <= i; j++) { sum += closes[j]; sq += closes[j] * closes[j]; }
  const mean = sum / p;
  return { mean, sd: Math.sqrt(Math.max(0, sq / p - mean * mean)) };
}

function computeIndicators() {
  const closes = state.candles.map((k) => Number(k.c));
  const times = state.candles.map((k) => k.t / 1000 + TZ_SHIFT);
  maSeries.forEach((s, idx) => {
    const p = MA_DEFS[idx].period;
    const pts = [];
    for (let i = p - 1; i < closes.length; i++) pts.push({ time: times[i], value: windowStats(closes, i, p).mean });
    s.setData(pts);
  });
  const { period: p, mult } = BB_DEF;
  const up = [], lo = [];
  for (let i = p - 1; i < closes.length; i++) {
    const { mean, sd } = windowStats(closes, i, p);
    up.push({ time: times[i], value: mean + mult * sd });
    lo.push({ time: times[i], value: mean - mult * sd });
  }
  bbSeries.upper.setData(up);
  bbSeries.lower.setData(lo);
  computeChannels();
}

// ---------- auto trend channels ----------
// スイングピボットの HH/HL・LH/LL 継続区間をトレンド区間として切り出し、
// 各区間に回帰直線 + 高値/安値への最大オフセットの平行線（チャネル）を引く。
// 短期/中期/長期の3スケールで検出するため、同じ時間帯に複数のチャネルが重なる。
// 色 #d0bd2b（黄）は既存5色との CVD 分離を dataviz validator で検証済み
//（明度は系列色の推奨帯より上だが、目立たせたい注釈線のため許容。破線が二次符号化）。

const TL_COLOR = "#d0bd2b";     // 検出区間（本体）
const TL_EXT_COLOR = "#2aa3ba"; // 延長部分（左右への外挿。黄との CVD 分離検証済み）
const TL_SCALES = [
  { k: 2, minBars: 10 },  // 短期: ±2本ピボット
  { k: 4, minBars: 25 },  // 中期
];
const TL_COHERENT_FRAC = 0.22; // 「一貫したチャネル」とみなす幅の上限（平均価格比）
const TL_COARSE_MIN = 10;      // 長期（トップダウン分割）チャネルの最小本数
const TL_FAST_BARS = 12;       // 長期バンドをこの本数未満で横断する傾き差 = 「急変」チャネル
const TL_RECENT_CRASH = 90;    // 急変チャネルを残す新しさ（本数）。それより古い断片は消す
const TL_MAX_CHANNELS = 16; // 描画上限（クラッタ防止）
const TL_EXTEND = 8;        // 右端に届くチャネルの未来方向への延長本数
const TL_FIT_TOL = 0.2;     // 延長続行の許容はみ出し（チャネル幅に対する比）
const TL_MIN_SUB = 8;       // 再帰分割の子・直近レッグの最小本数
const TL_SPLIT_GAIN = 0.75; // 分割で子チャネル幅がこの比率未満に縮む場合のみ分割
const TL_RECENT_WIN = 30;   // 直近レッグの起点（最安値/最高値）を探す窓
const TL_OUTLIER = 0.04;    // チャネル上下限が無視してよいバーの割合（片側）

let tlSeries = []; // 使い回す line series プール（チャネル1本 = 上下2系列）

// 高値/安値のスイングピボット（±k本の最値）を検出し、H/L 交互の列にして返す
function findPivots(hs, ls, k) {
  const raw = [];
  for (let i = k; i < hs.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (hs[j] > hs[i]) isH = false;
      if (ls[j] < ls[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) raw.push({ i, px: hs[i], hi: true });
    else if (isL) raw.push({ i, px: ls[i], hi: false });
  }
  const out = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && last.hi === p.hi) {
      if (p.hi ? p.px >= last.px : p.px <= last.px) out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

// 同種ピボット（2本前）との比較方向が反転した所でトレンド区間を区切る
function trendSegments(pivots, nBars) {
  const segs = [];
  let start = 0, dir = 0;
  for (let n = 2; n < pivots.length; n++) {
    const d = Math.sign(pivots[n].px - pivots[n - 2].px) || dir;
    if (dir === 0) dir = d;
    else if (d !== dir) {
      segs.push({ a: pivots[start].i, b: pivots[n - 1].i });
      start = n - 1;
      dir = 0; // 新区間の向きは次の同種比較で決める
    }
  }
  segs.push({ a: pivots[start]?.i ?? 0, b: nBars - 1, live: true });
  return segs;
}

// 終値の最小二乗直線と、高値/安値へのオフセット（平行チャネルの上下）。
// 上下限は全バーを含む最大値ではなく、片側 TL_OUTLIER の割合のバーの
// はみ出しを許容した分位点（極端なヒゲ数本でチャネル幅が水増しされない）。
function fitChannel(a, b, hs, ls, cs) {
  const n = b - a + 1;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = a; i <= b; i++) {
    const x = i - a, y = cs[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  const m = den ? (n * sxy - sx * sy) / den : 0;
  const c = (sy - m * sx) / n;
  const rh = [], rl = [];
  for (let i = a; i <= b; i++) {
    const base = m * (i - a) + c;
    rh.push(hs[i] - base);
    rl.push(ls[i] - base);
  }
  rh.sort((x, y) => y - x); // 降順: [0] が最大はみ出し
  rl.sort((x, y) => x - y); // 昇順
  const drop = Math.floor(n * TL_OUTLIER);
  return { m, c, up: rh[drop], dn: rl[drop] };
}

// チャネル幅が平均価格の TL_COHERENT_FRAC 以内なら「一貫したチャネル」とみなす。
// 幅の相対比較（分割ゲイン）と違い絶対基準なので、レンジ帯全体を1本と判定できる。
function coherentChannel(a, b, hs, ls, cs) {
  const f = fitChannel(a, b, hs, ls, cs);
  let sum = 0;
  for (let i = a; i <= b; i++) sum += cs[i];
  return f.up - f.dn <= TL_COHERENT_FRAC * (sum / (b - a + 1));
}

// 長期チャネル: 全期間をトップダウンに「一貫したチャネルになるまで」分割し、
// 分割点がレンジ中央を割った場合に備えて隣接リーフを再統合する。
// ピボットに依らないため、数ヶ月におよぶレンジ帯が一組の平行線にまとまる。
function coarseSegments(hs, ls, cs) {
  const out = [];
  const rec = (a, b, depth, arr) => {
    if (depth <= 0 || b - a + 1 < TL_MIN_SUB * 2 || coherentChannel(a, b, hs, ls, cs)) {
      arr.push({ a, b });
      return;
    }
    let best = -1, bestW = Infinity;
    for (let i = a + TL_MIN_SUB - 1; i <= b - TL_MIN_SUB + 1; i++) {
      const f1 = fitChannel(a, i, hs, ls, cs);
      const f2 = fitChannel(i, b, hs, ls, cs);
      const w = Math.max(f1.up - f1.dn, f2.up - f2.dn);
      if (w < bestW) { bestW = w; best = i; }
    }
    rec(a, best, depth - 1, arr);
    rec(best, b, depth - 1, arr);
  };
  rec(0, hs.length - 1, 5, out);
  const mergePass = () => {
    for (let i = 0; i + 1 < out.length; ) {
      const A = out[i], B = out[i + 1];
      if (coherentChannel(A.a, B.b, hs, ls, cs)) {
        out.splice(i, 2, { a: A.a, b: B.b });
        if (i > 0) i--;
      } else i++;
    }
  };
  mergePass();
  // 境界の局所最適化: 貪欲2分割の境界は天井/大底から数本ズレることがある
  //（例: 持ち合いの始点/終点）。各内部境界を±20本の範囲で動かし、隣接2区間の
  // 「チャネル幅×長さ」の合計が最小になる位置へ置き直す。
  const cost = (a, b) => { const f = fitChannel(a, b, hs, ls, cs); return (f.up - f.dn) * (b - a + 1); };
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i + 1 < out.length; i++) {
      const A = out[i], B = out[i + 1];
      let bestJ = A.b, bestC = cost(A.a, A.b) + cost(B.a, B.b);
      const lo = Math.max(A.a + TL_MIN_SUB - 1, A.b - 20);
      const hi = Math.min(B.b - TL_MIN_SUB + 1, A.b + 20);
      for (let j = lo; j <= hi; j++) {
        if (j === A.b) continue;
        const c2 = cost(A.a, j) + cost(j, B.b);
        if (c2 < bestC) { bestC = c2; bestJ = j; }
      }
      if (bestJ !== A.b) { A.b = bestJ; B.a = bestJ; moved = true; }
    }
    if (!moved) break;
  }
  // 境界を近傍の価格転換点へスナップ: 境界の前後で傾きが下向きに変わるなら
  // 局所高値（天井）、上向きに変わるなら局所安値（大底）に境界を置く
  //（幅コストだけでは天井の数本手前で止まることがある — 2026-01 の持ち合い上限で実例）
  for (let i = 0; i + 1 < out.length; i++) {
    const A = out[i], B = out[i + 1];
    const slope = (a, b) => fitChannel(a, b, hs, ls, cs).m;
    const down = slope(B.a, B.b) < slope(A.a, A.b);
    const lo = Math.max(A.a + TL_MIN_SUB - 1, A.b - 10);
    const hi = Math.min(B.b - TL_MIN_SUB + 1, A.b + 10);
    let bestJ = A.b, bestV = down ? -Infinity : Infinity;
    for (let j = lo; j <= hi; j++) {
      const v = down ? hs[j] : ls[j];
      if (down ? v > bestV : v < bestV) { bestV = v; bestJ = j; }
    }
    A.b = bestJ;
    B.a = bestJ;
  }
  mergePass(); // 境界移動で一貫化した隣接区間を再統合
  // 境界調整の結果、一貫性を失った区間を再分割する
  //（例: 天井スナップで「踊り場+滝」が同居した 2026-01 の急落区間 — 分割で
  //   踊り場は前の持ち合いに統合され、滝が独立した急落チャネルになる）
  for (let i = 0; i < out.length; ) {
    const s = out[i];
    if (s.b - s.a + 1 >= TL_MIN_SUB * 2 && !coherentChannel(s.a, s.b, hs, ls, cs)) {
      const sub = [];
      rec(s.a, s.b, 3, sub);
      if (sub.length > 1) {
        out.splice(i, 1, ...sub);
        i += sub.length;
        continue;
      }
    }
    i++;
  }
  mergePass();
  return out.filter((s) => s.b - s.a + 1 >= TL_COARSE_MIN);
}

// 区間を2分割した際に「広い方の子チャネル幅」が最小になる分割点を全候補から
// 探し、それが親チャネル幅の TL_SPLIT_GAIN 倍未満に縮む場合のみ再帰分割する。
// 急落とその後のもみ合いが1区間に融合するのを分けるのが目的で、
// 素直なトレンドやレンジは分割されずそのまま残る。
function refineSegment(a, b, hs, ls, cs, depth) {
  if (depth <= 0 || b - a + 1 < TL_MIN_SUB * 2) return [{ a, b }];
  const fit = fitChannel(a, b, hs, ls, cs);
  let best = -1, bestW = Infinity;
  for (let i = a + TL_MIN_SUB - 1; i <= b - TL_MIN_SUB + 1; i++) {
    const f1 = fitChannel(a, i, hs, ls, cs);
    const f2 = fitChannel(i, b, hs, ls, cs);
    const w = Math.max(f1.up - f1.dn, f2.up - f2.dn);
    if (w < bestW) { bestW = w; best = i; }
  }
  if (bestW < TL_SPLIT_GAIN * (fit.up - fit.dn)) {
    return [
      ...refineSegment(a, best, hs, ls, cs, depth - 1),
      ...refineSegment(best, b, hs, ls, cs, depth - 1),
    ];
  }
  return [{ a, b }];
}

function ensureTlSeries(count) {
  while (tlSeries.length < count) {
    tlSeries.push(chart.addLineSeries({
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null, // チャネル線で縦スケールを広げない
      visible: IND_CFG.tl,
    }));
  }
  for (let i = count; i < tlSeries.length; i++) tlSeries[i].setData([]);
}

function computeChannels() {
  const ks = state.candles;
  const hs = ks.map((k) => Number(k.h));
  const ls = ks.map((k) => Number(k.l));
  const cs = ks.map((k) => Number(k.c));
  // 長期（トップダウン分割）+ 短期/中期（ピボット）で検出 → 長期優先で
  // 「ほぼ同一区間」の重複だけ除去（重なり自体は許容）
  const found = [];
  if (ks.length >= TL_MIN_SUB * 2) {
    for (const s of coarseSegments(hs, ls, cs)) found.push({ ...s, k: 99 });
  }
  for (const sc of TL_SCALES) {
    if (ks.length < sc.minBars) continue;
    for (const s of trendSegments(findPivots(hs, ls, sc.k), ks.length)) {
      if (s.b - s.a + 1 < sc.minBars) continue;
      for (const r of refineSegment(s.a, s.b, hs, ls, cs, 4)) {
        if (r.b - r.a + 1 >= TL_MIN_SUB) found.push({ ...r, k: sc.k });
      }
    }
  }
  // 直近レッグ: 反転が未確定でも、直近窓の最安値/最高値から現在までを常に候補にする
  if (ks.length >= TL_MIN_SUB) {
    const n = ks.length, w0 = n - Math.min(TL_RECENT_WIN, n);
    let iMin = w0, iMax = w0;
    for (let i = w0; i < n; i++) {
      if (ls[i] < ls[iMin]) iMin = i;
      if (hs[i] > hs[iMax]) iMax = i;
    }
    for (const a of new Set([iMin, iMax])) {
      if (n - a >= TL_MIN_SUB) found.push({ a, b: n - 1, k: 1 });
    }
  }
  found.sort((x, y) => y.k - x.k || y.b - x.b); // 長期スケール優先、次に新しい順
  const coarse = found.filter((s) => s.k === 99);
  const segs = [];
  for (const s of found) {
    if (segs.length >= TL_MAX_CHANNELS) break;
    const len = s.b - s.a + 1;
    const dup = segs.some((t) => Math.abs(t.a - s.a) + Math.abs(t.b - s.b) < len * 0.3);
    if (dup) continue;
    // 短期/中期チャネルは「大トレンド把握」のテーゼに合わせ、
    //   ①右端に届く現況チャネル、または
    //   ②直近 TL_RECENT_CRASH 本以内の急変（重なる長期バンドを TL_FAST_BARS 本
    //     未満で横断する傾き差 = 急落/急騰）
    // だけ残す。過去の細かいレッグや長期内を漂うだけの中間チャネルは消す。
    if (s.k !== 99 && s.b < ks.length - 3) {
      if (ks.length - 1 - s.b > TL_RECENT_CRASH) continue;
      const fs = fitChannel(s.a, s.b, hs, ls, cs);
      const overlap = (c) => Math.min(c.b, s.b) - Math.max(c.a, s.a);
      const c = coarse.filter((c) => overlap(c) > 0)
        .sort((x, y) => overlap(y) - overlap(x))[0];
      if (c) {
        const fc = fitChannel(c.a, c.b, hs, ls, cs);
        if (Math.abs(fs.m - fc.m) < (fc.up - fc.dn) / TL_FAST_BARS) continue;
      }
    }
    segs.push(s);
  }
  state.tlSegs = segs; // 検証用（puppeteer からの確認に使う）
  const iv = IV_MS[state.interval] / 1000;
  const lastT = ks.length ? ks[ks.length - 1].t / 1000 : 0;
  const t = (i) => (i < ks.length ? ks[i].t / 1000 : lastT + (i - ks.length + 1) * iv) + TZ_SHIFT;
  // 検出区間の外側へも「バーがチャネル内（許容込み）に収まる限り」延長する。
  // 右端まで届いたチャネルはさらに未来へ TL_EXTEND 本延長。延長部分は色を変える。
  const lines = [];
  for (const s of segs) {
    const { m, c, up, dn } = fitChannel(s.a, s.b, hs, ls, cs);
    const tol = (up - dn) * TL_FIT_TOL;
    const y = (i, off) => m * (i - s.a) + c + off;
    const fits = (i) => hs[i] <= y(i, up) + tol && ls[i] >= y(i, dn) - tol;
    // 延長は自身の区間長まで（遠い過去/未来まで画面を横切る無駄線を防ぐ）
    const len = s.b - s.a + 1;
    let L = s.a;
    while (L > Math.max(0, s.a - len) && fits(L - 1)) L--;
    let R = s.b;
    while (R < Math.min(ks.length - 1, s.b + len) && fits(R + 1)) R++;
    s.L = L; s.R = R; // シグナル判定は延長込みのフィット確認済み範囲で行う
    // 未来への延長は緩やかなチャネルのみ。急勾配の外挿は右端の空間に
    // 宙に浮いた短い急斜線を生むだけで紛らわしい
    if (R === ks.length - 1 && Math.abs(m) * TL_EXTEND <= 0.35 * (up - dn)) R += TL_EXTEND;
    for (const off of [up, dn]) {
      const pt = (i) => ({ time: t(i), value: y(i, off) });
      lines.push({ color: TL_COLOR, pts: [pt(s.a), pt(s.b)] });
      if (L < s.a) lines.push({ color: TL_EXT_COLOR, pts: [pt(L), pt(s.a)] });
      if (R > s.b) lines.push({ color: TL_EXT_COLOR, pts: [pt(s.b), pt(R)] });
    }
  }
  state.tlLines = lines; // 検証用（puppeteer からの確認に使う）
  ensureTlSeries(lines.length);
  lines.forEach((ln, i) => {
    tlSeries[i].applyOptions({ color: ln.color });
    tlSeries[i].setData(ln.pts);
  });
  computeTlSignals(segs, hs, ls, cs, t);
}

// チャネル×BB の交差シグナル: BB 下バンドがチャネル下線を下抜けた足（弱気 ▼）と、
// BB 上バンドがチャネル上線を上抜けた足（強気 ▲）をローソクにマーカー表示する。
// ユーザーの観察（2026-06 上旬: 上昇チャネル下線と BB 下バンドの交差から本格急落）に基づく。
function computeTlSignals(segs, hs, ls, cs, t) {
  const { period: p, mult } = BB_DEF;
  const bbUp = [], bbLo = [];
  for (let i = 0; i < cs.length; i++) {
    if (i < p - 1) { bbUp.push(NaN); bbLo.push(NaN); continue; }
    const { mean, sd } = windowStats(cs, i, p);
    bbUp.push(mean + mult * sd);
    bbLo.push(mean - mult * sd);
  }
  // パターン監視の対象 = 右端まで生きている最長の長期チャネル
  const live = segs
    .filter((s) => s.k === 99 && (s.R ?? s.b) >= cs.length - 1)
    .sort((x, y) => x.a - y.a)[0];
  let liveUp = -1, liveDn = -1; // live チャネル自身の直近 ▲/▼ の足 index
  const sigs = new Map(); // "index:dir" -> {i, dir}（同一足の重複シグナルは1つに）
  for (const s of segs) {
    const { m, c, up, dn } = fitChannel(s.a, s.b, hs, ls, cs);
    const y = (i, off) => m * (i - s.a) + c + off;
    // 評価は左右の延長を含む「バーがチャネルに収まると確認済みの範囲」全体
    //（例: 持ち合い天井の延長線を BB 上バンドが突き抜ける = 過熱シグナル）
    for (let i = Math.max(s.L ?? s.a, p); i <= Math.min(s.R ?? s.b, cs.length - 1); i++) {
      if (bbLo[i - 1] >= y(i - 1, dn) && bbLo[i] < y(i, dn)) {
        sigs.set(i + ":-1", { i, dir: -1 });
        if (s === live && i > liveDn) liveDn = i;
      }
      if (bbUp[i - 1] <= y(i - 1, up) && bbUp[i] > y(i, up)) {
        sigs.set(i + ":1", { i, dir: 1 });
        if (s === live && i > liveUp) liveUp = i;
      }
    }
  }
  state.tlMarkers = [...sigs.values()]
    .sort((a, b) => a.i - b.i)
    .map((s) => s.dir < 0
      ? { time: t(s.i), position: "aboveBar", color: "#e66767", shape: "arrowDown", size: 1 }
      : { time: t(s.i), position: "belowBar", color: "#0ca30c", shape: "arrowUp", size: 1 });
  applyTlMarkers();

  // 急落先取りのパターン判定: 過去2回（11-1月・2-6月）は「2〜4ヶ月の緩い
  // 上昇/横ばいチャネル → 天井過熱(▲) → 床破断(▼) → 急落」の順で進んだ。
  // 右端の live チャネルが同じ形なら、その進行段階をバッジで示す。
  state.tlWatch = null;
  if (live) {
    const f = fitChannel(live.a, live.b, hs, ls, cs);
    const w = f.up - f.dn;
    const age = cs.length - live.a;
    // 「緩い」= 明確な下降でなく（幅を50本未満で割り込む傾きは除外）、
    // 急騰でもない（幅を25本未満で突き抜ける傾きは除外）
    if (age >= 30 && f.m > -w / 50 && f.m < w / 25) {
      const d0 = new Date(state.candles[live.a].t);
      const n1 = cs.length - 1;
      // 局面タグ: 14年バックテストで「破断→30日で-18%」の率は弱気局面（終値<SMA200）
      // 32% vs 強気局面 5% と大差 — 破断シグナルは下落局面でのみ信頼する
      let regime = "", regimeTag = "";
      if (cs.length >= 200) {
        let s200 = 0;
        for (let i = cs.length - 200; i < cs.length; i++) s200 += cs[i];
        regime = cs[n1] < s200 / 200 ? "bear" : "bull";
        regimeTag = regime === "bear"
          ? T(" · 弱気局面", " · bear regime")
          : T(" · 強気局面(破断は騙し多め)", " · bull regime (breaks often fake)");
      }
      let cls = "watch-calm", stage = "calm", txt = T("監視中（▲/▼ 待ち）", "watching (awaiting ▲/▼)");
      if (liveDn >= 0 && n1 - liveDn <= 5) {
        const ago = n1 - liveDn === 0 ? T("本日", "today") : T(`${n1 - liveDn}日前`, `${n1 - liveDn}d ago`);
        cls = "watch-break"; stage = "break";
        txt = T(`床破断 ▼ ${ago} — 過去2回はここから急落`, `floor break ▼ ${ago} — last 2 crashes started here`);
      } else if (liveUp >= 0 && n1 - liveUp <= 15) {
        cls = "watch-hot"; stage = "hot";
        txt = T(`天井過熱 ▲ ${n1 - liveUp}日前 — 床破断(▼)を警戒`, `ceiling heat ▲ ${n1 - liveUp}d ago — watch for floor break (▼)`);
      }
      state.tlWatch = {
        cls, stage, regime,
        text: T(`パターン監視: ${d0.getMonth() + 1}/${d0.getDate()}〜 ${age}日目 · ${txt}${regimeTag}`,
                `Pattern watch: since ${d0.getMonth() + 1}/${d0.getDate()}, day ${age} · ${txt}${regimeTag}`),
      };
    }
  }
  applyTlWatch();
}

// ---------- 実需フィード（crypto_analysis/realtime_demand と連携・任意） ----------
// 同一ホストの port 8765 で realtime_demand サーバーが動いていれば WS 接続し、
// spot/perp のテイカーフロー5分判定をパターン監視バッジに融合する
//（テクニカルの ▼ を実需の買いが覆した 2026-04-01 の教訓 — 床破断時に現物買いが
// 強ければ「騙し」の可能性を注記する）。サーバーが無ければ静かに諦めて
// テクニカルのみで表示。localStorage "hlt-demand" で URL 上書き・"off" で無効化。
const DEMAND_URL = (() => {
  try {
    const u = localStorage.getItem("hlt-demand");
    if (u === "off") return null;
    // https ページからは平文 ws:// が mixed content でブロックされるため wss リスナー（8766）を使う
    return u || (location.protocol === "https:"
      ? `wss://${location.hostname}:8766/ws`
      : `ws://${location.hostname}:8765/ws`);
  } catch { return null; }
})();

const demand = { points: [], ok: false, retryMs: 5000 };

function demandConnect() {
  if (!DEMAND_URL) return;
  let ws;
  try { ws = new WebSocket(DEMAND_URL); } catch { return; }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snap") demand.points = msg.history;
    else if (msg.type === "tick") demand.points.push(msg.p);
    if (demand.points.length > 900) demand.points.splice(0, demand.points.length - 900);
    demand.ok = true;
    demand.retryMs = 5000;
  };
  ws.onclose = () => {
    demand.ok = false;
    setTimeout(demandConnect, demand.retryMs);
    demand.retryMs = Math.min(demand.retryMs * 2, 120000);
  };
  ws.onerror = () => ws.close();
}

// 直近5分のテイカーフロー方向（realtime_demand の classify と同じ閾値・簡約版）
// 戻り値: 1=買い優勢 / -1=売り優勢 / 0=中立・閑散 / null=データ無し・鮮度切れ
function demandDir(keys) {
  const pts = demand.points;
  if (!demand.ok || !pts.length) return null;
  const lastT = pts[pts.length - 1].t;
  if (Date.now() / 1000 - lastT > 30) return null;
  let buy = 0, sell = 0, oldest = lastT;
  for (let i = pts.length - 1; i >= 0 && lastT - pts[i].t < 300; i--) {
    for (const k of keys) {
      const v = pts[i][k];
      if (v) { buy += v[2]; sell += v[3]; }
    }
    oldest = pts[i].t;
  }
  if (lastT - oldest < 60 || buy + sell < 0.05) return 0;
  const r = (buy - sell) / (buy + sell);
  return r >= 0.12 ? 1 : r <= -0.12 ? -1 : 0;
}

// パターン監視バッジは日足かつ TL・BB 両 ON のときだけ表示（判定基準が日足前提のため）。
// 実需フィードが生きていれば現物/perp の5分フローを追記する。
function applyTlWatch() {
  const el = $("tl-watch");
  const w = state.tlWatch;
  const show = !!w && state.interval === "1d" && IND_CFG.tl && IND_CFG.bb;
  el.hidden = !show;
  if (!show) return;
  let text = w.text;
  const spot = demandDir(["bspot", "cspot"]);
  const perp = demandDir(["bperp"]);
  if (spot !== null && perp !== null) {
    const lb = LANG === "en"
      ? { "1": "buy", "0": "flat", "-1": "sell" }
      : { "1": "買", "0": "中立", "-1": "売" };
    text += T(` · 実需5分: 現物${lb[spot]}/perp${lb[perp]}`, ` · 5m flow: spot ${lb[spot]}/perp ${lb[perp]}`);
    if (w.cls === "watch-break") {
      text += spot > 0 ? T("（⚠ 現物は買い — 騙しの可能性）", " (⚠ spot buying — possible fakeout)")
        : spot < 0 ? T("（現物も売り — 信頼度高）", " (spot selling too — high confidence)") : "";
    }
  }
  el.textContent = text;
  el.className = w.cls;
  updateCrashAlert();
}

// ---------- 総合急落警報 ----------
// 局面（SMA200）× パターン段階 × 実需フローの合議でレベルを決める:
//   レベル3 = 弱気局面で床破断し、実需の現物買い支えが無い
//            （バックテストで 30日内 -18% 超が 32% だった構成）→ 赤バナー+通知+ビープ
//   レベル2 = 床破断だが現物買い（騙しの可能性）/ 弱気局面の天井過熱 → 琥珀バナー
//   レベル1 = 弱気局面で成熟チャネル監視中（バッジのみ）
function updateCrashAlert() {
  const w = state.tlWatch;
  const el = $("crash-alert");
  const spot = demandDir(["bspot", "cspot"]);
  let lv = 0;
  if (w && state.interval === "1d" && IND_CFG.tl && IND_CFG.bb) {
    const bear = w.regime === "bear";
    if (w.stage === "break") lv = bear && (spot === null || spot <= 0) ? 3 : 2;
    else if (w.stage === "hot" && bear) lv = 2;
    else if (bear) lv = 1;
  }
  state.alertLevel = lv;
  if (lv >= 2) {
    const spotTxt = spot === null ? ""
      : spot > 0 ? T(" · 実需: 現物買い(騙し注意)", " · flow: spot buying (fakeout risk)")
      : spot < 0 ? T(" · 実需: 現物も売り", " · flow: spot selling too")
      : T(" · 実需: 中立", " · flow: neutral");
    el.textContent = lv >= 3
      ? T(`🚨 急落警報 — 床破断▼ · 弱気局面${spotTxt}`, `🚨 Crash alert — floor break ▼ · bear regime${spotTxt}`)
      : T(`⚠ 急落警戒 — ${w.stage === "break" ? "床破断▼" : "天井過熱▲"}${spotTxt}`,
          `⚠ Crash warning — ${w.stage === "break" ? "floor break ▼" : "ceiling heat ▲"}${spotTxt}`);
    el.className = lv >= 3 ? "alert-3" : "alert-2";
    el.hidden = false;
  } else {
    el.hidden = true;
  }
  // レベル3はブラウザ通知+ビープ（日付×レベルで重複抑止 — 再読込では鳴らさない。
  // 2画面時は右ペインを黙らせて二重発火を防ぐ — バナー表示は両ペインに出る）
  if (lv >= 3 && PANE !== "2") {
    const key = new Date().toISOString().slice(0, 10) + ":" + lv;
    if (localStorage.getItem("hlt-alerted") !== key) {
      localStorage.setItem("hlt-alerted", key);
      notifyCrash(el.textContent);
      beep();
    }
  }
}

function notifyCrash(body) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") new Notification("HL Terminal", { body });
    else if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") new Notification("HL Terminal", { body });
      });
    }
  } catch { /* 通知不可の環境では黙って諦める */ }
}

function beep() {
  try {
    const ctx = new AudioContext();
    for (const dt of [0, 0.3]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.15;
      o.start(ctx.currentTime + dt);
      o.stop(ctx.currentTime + dt + 0.18);
    }
  } catch { /* ユーザー操作前は AudioContext が使えないことがある */ }
}

// シグナルはチャネルと BB 両方に依存するため、両トグルが ON のときだけ表示
function applyTlMarkers() {
  candleSeries.setMarkers(IND_CFG.tl && IND_CFG.bb ? state.tlMarkers || [] : []);
}

function updateIndicatorsLast() {
  const closes = state.candles.map((k) => Number(k.c));
  const i = closes.length - 1;
  if (i < 0) return;
  const time = state.candles[i].t / 1000 + TZ_SHIFT;
  maSeries.forEach((s, idx) => {
    const p = MA_DEFS[idx].period;
    if (i >= p - 1) s.update({ time, value: windowStats(closes, i, p).mean });
  });
  if (i >= BB_DEF.period - 1) {
    const { mean, sd } = windowStats(closes, i, BB_DEF.period);
    bbSeries.upper.update({ time, value: mean + BB_DEF.mult * sd });
    bbSeries.lower.update({ time, value: mean - BB_DEF.mult * sd });
  }
}

function applyIndicatorVisibility() {
  maSeries.forEach((s) => s.applyOptions({ visible: IND_CFG.ma }));
  bbSeries.upper.applyOptions({ visible: IND_CFG.bb });
  bbSeries.lower.applyOptions({ visible: IND_CFG.bb });
  tlSeries.forEach((s) => s.applyOptions({ visible: IND_CFG.tl }));
  applyTlMarkers();
  applyTlWatch();
  $("ind-ma").classList.toggle("active", IND_CFG.ma);
  $("ind-bb").classList.toggle("active", IND_CFG.bb);
  $("ind-tl").classList.toggle("active", IND_CFG.tl);
  renderChartLegend();
}

function renderChartLegend() {
  const items = [];
  if (IND_CFG.ma) for (const d of MA_DEFS) items.push([d.color, `MA ${d.period}`]);
  if (IND_CFG.bb) items.push([BB_DEF.color, `BB (${BB_DEF.period}, ${BB_DEF.mult}σ)`]);
  if (IND_CFG.tl) items.push([TL_COLOR, T("チャネル (自動)", "Channels (auto)")], [TL_EXT_COLOR, T("チャネル延長", "Channel ext.")]);
  const el = $("chart-legend");
  el.hidden = !items.length;
  el.innerHTML = items
    .map(([c, label]) => `<span class="lg-item"><span class="lg-swatch" style="background:${c}"></span>${label}</span>`)
    .join("");
}

for (const [id, key] of [["ind-ma", "ma"], ["ind-bb", "bb"], ["ind-tl", "tl"]]) {
  $(id).addEventListener("click", () => {
    IND_CFG[key] = !IND_CFG[key];
    localStorage.setItem("hlt-ind", JSON.stringify({ ma: IND_CFG.ma, bb: IND_CFG.bb, tl: IND_CFG.tl }));
    applyIndicatorVisibility();
  });
}

function setupChart() {
  const common = {
    layout: { background: { color: "#0d0d0d" }, textColor: "#898781" },
    grid: {
      vertLines: { color: "#2c2c2a" },
      horzLines: { color: "#2c2c2a" },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#383835" },
  };
  // 上段: ローソク足 + 指標（時間軸ラベルは下段のボリュームペインにのみ表示）
  chart = LightweightCharts.createChart($("chart"), {
    ...common,
    timeScale: {
      visible: false,
      rightOffset: 5,
      shiftVisibleRangeOnNewBar: true,
    },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#0ca30c", downColor: "#e66767",
    wickUpColor: "#0ca30c", wickDownColor: "#e66767",
    borderVisible: false,
  });
  // 下段: ボリューム専用ペイン
  volChart = LightweightCharts.createChart($("vol-chart"), {
    ...common,
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: "#383835",
      rightOffset: 5,
      shiftVisibleRangeOnNewBar: false, // 追従は上段からの同期で行う（二重シフト防止）
    },
  });
  volumeSeries = volChart.addHistogramSeries({
    priceFormat: { type: "volume" },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  volChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
  addIndicatorSeries();

  // 2つのチャートの表示範囲を相互同期（ガード付き）
  let syncing = false;
  const syncRange = (from, to) => (r) => {
    if (syncing || !r) return;
    syncing = true;
    to.timeScale().setVisibleLogicalRange(r);
    syncing = false;
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(chart, volChart));
  volChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange(volChart, chart));

  new ResizeObserver(() => {
    chart.resize($("chart").clientWidth, $("chart").clientHeight);
    volChart.resize($("vol-chart").clientWidth, $("vol-chart").clientHeight);
  }).observe($("chart-pane"));
}

// 右側の価格スケール幅を上下で揃える（ずれるとローソクとボリュームの列が揃わない）
let lastScaleW = 0;
function syncPriceScaleWidths() {
  const w = Math.max(chart.priceScale("right").width(), volChart.priceScale("right").width());
  if (w === lastScaleW) return;
  lastScaleW = w;
  chart.applyOptions({ rightPriceScale: { minimumWidth: w } });
  volChart.applyOptions({ rightPriceScale: { minimumWidth: w } });
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
  state.candles = ks;
  computeIndicators();
  state.lastCandleT = ks.length ? ks[ks.length - 1].t : 0;
  // 全300本を収めると1本が数pxになり足の更新が見えないため、直近約80本を表示
  // （最終バーの論理位置は ks.length-1。右余白は rightOffset と同じ5本に揃える。
  //   週足・月足などデータが80本未満のときは左端に合わせる）
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(ks.length - 81, -2), to: ks.length + 4 });
  syncPriceScaleWidths();
}

// ---------- order book ----------

function renderBook(data) {
  // WS snapshot と REST ポーリングが併走するため、描画済みより古いデータは捨てる
  if (data.time && data.time <= state.bookTime) return;
  if (data.time) state.bookTime = data.time;
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
  state.markPx = mark;
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
  const warn = state.alertLevel >= 3 ? "🚨 " : state.alertLevel === 2 ? "⚠ " : "";
  document.title = `${warn}${fmtPx(mark)} ${state.coin} · HL Terminal`;
}

// ---------- サブティッカー（HIP-3 xyz DEX 銘柄の常時表示） ----------
// topbar 直下に xyz:CL と xyz:MU を常時表示する。公式 UI の「WTIOIL-USDC」は
// API 名 xyz:CL と同一銘柄（perpConciseAnnotations の displayName が WTIOIL）。
// activeAssetCtx を常時購読（銘柄切替の unsubscribe 対象外）し、
// 初期値は REST（dex 指定の metaAndAssetCtxs）。xyz DEX の無い接続先（testnet 等）では
// REST が失敗 or 銘柄が見つからず、行ごと非表示のままになる。

const TICKER_DEX = "xyz";
const TICKER_COINS = [
  { coin: "xyz:CL", label: "WTIOIL" },
  { coin: "xyz:GOLD", label: "GOLD" },
  { coin: "xyz:XYZ100", label: "Nasdaq100" }, // 公式表示名は XYZ100（annotations keywords: nasdaq/qqq）だがユーザー指定の呼称で表示
  { coin: "xyz:MU", label: "MU" },
  { coin: "xyz:SPCX", label: "SPCX" },
];
// 2画面時のサブティッカーは左ペインのみ（共通表示は一つ、というユーザー要望）。
// 右ペインは REST 初期化・常時購読ごと省略する
const TICKER_ON = PANE !== "2";
const tickerCtxs = {}; // coin -> assetCtx

function renderTicker() {
  if (!TICKER_ON) return; // hidden のまま（銘柄として xyz:CL を表示中でも出さない）
  const items = TICKER_COINS.filter((t) => tickerCtxs[t.coin]);
  // 2画面時は duo.html 最上段の共通ティッカーへ描画（左ペインがデータ供給役）
  const el = (FRAMED && window.top.document.getElementById("ticker")) || $("ticker");
  el.hidden = !items.length;
  if (!items.length) return;
  // 構造は初回（と銘柄数の変化時）のみ生成。毎回 innerHTML を作り直すとスマホの
  // マーキーアニメーションが巻き戻るため、以後は数値のテキストだけ差し替える。
  // track を2連にするのはマーキーのシームレスループ用（PC では2本目を CSS で非表示）
  if (el.dataset.count !== String(items.length)) {
    const cell = (t) =>
      `<span class="tk-item" title="${t.coin} (mark / 24h)"><span class="tk-label">${t.label}</span>` +
      `<span class="tk-px"></span><span class="tk-chg value"></span></span>`;
    const track = `<span class="tk-track">${items.map(cell).join("")}</span>`;
    el.innerHTML = `<span class="tk-wrap">${track}${track}</span>`;
    el.dataset.count = String(items.length);
  }
  for (const track of el.querySelectorAll(".tk-track")) {
    track.querySelectorAll(".tk-item").forEach((node, i) => {
      const c = tickerCtxs[items[i].coin];
      const mark = Number(c.markPx);
      const prev = Number(c.prevDayPx);
      const chg = prev ? ((mark - prev) / prev) * 100 : 0;
      node.querySelector(".tk-px").textContent = fmtAnyPx(mark);
      const chgEl = node.querySelector(".tk-chg");
      chgEl.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
      chgEl.className = "tk-chg value " + (chg >= 0 ? "up" : "down");
    });
  }
}

async function loadTicker() {
  if (!TICKER_ON) return;
  try {
    const [meta, ctxs] = await info({ type: "metaAndAssetCtxs", dex: TICKER_DEX });
    meta.universe.forEach((u, i) => {
      if (TICKER_COINS.some((t) => t.coin === u.name)) tickerCtxs[u.name] = ctxs[i];
    });
  } catch { /* xyz DEX の無い接続先では非表示のまま */ }
  renderTicker();
}

// ---------- websocket ----------

function subs(coin, interval) {
  const s = [
    { type: "l2Book", coin },
    { type: "trades", coin },
    { type: "candle", coin, interval },
  ];
  // ティッカー銘柄の activeAssetCtx は常時購読済み — 二重 subscribe や切替時の unsubscribe を避ける
  // （ティッカーを持たない右ペインでは通常どおり銘柄ごとに購読する）
  if (!(TICKER_ON && TICKER_COINS.some((t) => t.coin === coin))) s.push({ type: "activeAssetCtx", coin });
  return s;
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
    state.lastWsMsg = Date.now();
    $("conn").className = "up";
    for (const s of subs(state.coin, state.interval)) wsSend("subscribe", s);
    // ティッカー銘柄は常時購読（switchTo の unsubscribe 対象にしない）
    if (TICKER_ON) for (const t of TICKER_COINS) wsSend("subscribe", { type: "activeAssetCtx", coin: t.coin });
    // 再接続時は切断中に欠けた足を REST で取り直す（欠けたまま WS 更新だけ再開すると
    // チャートに穴が空き、追従も過去に置き去りになる）。初回接続はロード側で取得済み
    if (state.everConnected) loadCandles().catch((e) => console.error("reload candles:", e));
    state.everConnected = true;
  };

  ws.onmessage = (ev) => {
    state.lastWsMsg = Date.now();
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
          if (isNewBar || !state.candles.length) state.candles.push(k);
          else state.candles[state.candles.length - 1] = k;
          if (state.candles.length > CANDLE_BARS * 2) state.candles.shift();
          updateIndicatorsLast();
          if (isNewBar) computeChannels(); // 新バーでピボット・区間が変わり得る
          syncPriceScaleWidths(); // 桁数の変化で価格軸幅が変わることがある
          // 足が切り替わったら右端へ追従（過去を見るためスクロール中は追従しない）
          if (isNewBar && chart.timeScale().scrollPosition() > -3) {
            chart.timeScale().scrollToRealTime();
          }
        }
        break;
      }
      case "activeAssetCtx":
        // ティッカー銘柄自身を表示中は両方更新する（else-if にしない）
        if (msg.data.coin === state.coin) renderStats(msg.data.ctx);
        if (TICKER_COINS.some((t) => t.coin === msg.data.coin)) {
          tickerCtxs[msg.data.coin] = msg.data.ctx;
          renderTicker();
        }
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

// WS の死活監視: スリープ復帰やネットワーク断で onclose が来ないままソケットが死ぬと、
// 板は REST ポーリングで動き続けるのにチャート（candle/trades は WS のみ）だけ止まる。
// l2Book スナップショットが約5秒間隔で必ず来るため、60秒無通信 = 死亡とみなして
// 作り直す（close() → onclose → 指数バックオフ再接続 → onopen で candleSnapshot 再取得）
setInterval(() => {
  if (state.wsReady && Date.now() - (state.lastWsMsg ?? 0) > 60000) {
    console.warn("WS silent for 60s — reconnecting");
    try { state.ws.close(); } catch { /* already dead */ }
  }
}, 15000);

// WS の l2Book snapshot は約5秒間隔でしか届かない（2026-07-15 実測: 公式/api-ui/api2 とも
// 中央値 5.4s、nSigFigs 指定でも不変）。板の鮮度は REST ポーリング（weight 2/回・~34ms）で
// 補い、WS 購読は切断時等のフォールバックとして維持する。古い方は renderBook の time
// ガードが捨てる。1s 間隔 ×2ペインでも 240 weight/分で IP 上限 1200/分に対し余裕
const BOOK_POLL_MS = 1000;
let bookPollBusy = false;
setInterval(async () => {
  if (document.hidden || bookPollBusy) return;
  bookPollBusy = true;
  const coin = state.coin;
  try {
    const d = await info({ type: "l2Book", coin });
    if (coin === state.coin) renderBook(d);
  } catch { /* 一時的な失敗は次周期に任せる */ }
  bookPollBusy = false;
}, BOOK_POLL_MS);

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
  // 右ペインは共有テーブルを描画しない — 発注・キャンセル直後の更新は供給役（左ペイン）に頼む
  if (!ACCT_ON) {
    for (const w of Array.from(window.top.frames)) {
      if (w !== window) { try { w.refreshAccount?.(); } catch { /* 相手ペイン初期化前 */ } }
    }
    return;
  }
  const user = state.user;
  try {
    const [ch, orders] = await Promise.all([
      info({ type: "clearinghouseState", user }),
      // openOrders ではなく frontend 版: 修正(batchModify)に必要な tif/reduceOnly/isTrigger が取れる
      info({ type: "frontendOpenOrders", user }),
    ]);
    if (user !== state.user) return; // switched/disconnected while in flight
    state.openOrders = orders;
    renderAccount(ch, orders);
  } catch (e) {
    console.error("account refresh failed:", e);
  }
}

function renderAccount(ch, orders) {
  const positions = ch.assetPositions.map((p) => p.position);
  state.positions = positions;
  const canTrade = typeof tradeReady === "function" && tradeReady();
  const upnl = positions.reduce((s, p) => s + Number(p.unrealizedPnl), 0);

  acct("ac-equity").textContent = fmtUsd2(ch.marginSummary.accountValue);
  // 取引可能 = 総資産 − 使用中証拠金（新規建てに使える余力。withdrawable とは未実現損益等の扱いが違う）
  acct("ac-avail").textContent = fmtUsd2(Math.max(0,
    Number(ch.marginSummary.accountValue) - Number(ch.marginSummary.totalMarginUsed)));
  acct("ac-withdraw").textContent = fmtUsd2(ch.withdrawable);
  acct("ac-margin").textContent = fmtUsd2(ch.marginSummary.totalMarginUsed);
  state.withdrawable = Number(ch.withdrawable); // 出金 UI のデフォルト値・上限チェック用
  // 入出金ボタンは署名できる接続（MetaMask）のときだけ出す
  const xfer = acct("acct-xfer");
  if (xfer) xfer.hidden = state.userSource !== "mm";
  const upEl = acct("ac-upnl");
  upEl.textContent = (upnl >= 0 ? "+" : "") + fmtUsd2(upnl);
  upEl.className = "value " + signCls(upnl);

  acct("positions").tBodies[0].innerHTML = positions.length
    ? positions.map((p) => {
        const sz = Number(p.szi);
        const mark = Math.abs(sz) > 0 ? Number(p.positionValue) / Math.abs(sz) : 0;
        const roe = (Number(p.returnOnEquity) * 100).toFixed(1);
        const close = canTrade && p.coin in state.assetIds
          ? `<button class="close-pos" data-coin="${p.coin}" title="${T("成行でクローズ（Reduce Only）", "Market close (reduce only)")}">${T("クローズ", "Close")}</button>` : "";
        return `<tr>
          <td class="coin">${p.coin} <span class="tag">${p.leverage.value}x</span></td>
          <td class="${signCls(sz)}">${fmtNum(sz, state.szDecimals[p.coin] ?? 4)}</td>
          <td>${fmtAnyPx(p.entryPx)}</td>
          <td>${fmtAnyPx(mark)}</td>
          <td class="${signCls(p.unrealizedPnl)}">${fmtUsd2(p.unrealizedPnl)} (${roe}%)</td>
          <td>${p.liquidationPx ? fmtAnyPx(p.liquidationPx) : "–"}</td>
          <td>${fmtUsd2(p.marginUsed)}</td>
          <td>${close}</td>
        </tr>`;
      }).join("")
    : `<tr><td class="empty" colspan="8">${T("ポジションなし", "No positions")}</td></tr>`;

  acct("orders").tBodies[0].innerHTML = orders.length
    ? orders
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((o) => {
          const side = o.side === "B" ? "buy" : "sell";
          const time = new Date(o.timestamp).toLocaleTimeString("ja-JP", { hour12: false });
          const actions = [];
          if (canTrade && o.coin in state.assetIds) {
            // 修正は通常の指値のみ（trigger/TPSL は未対応）
            if (!o.isTrigger && o.orderType === "Limit" && ["Gtc", "Alo", "Ioc"].includes(o.tif)) {
              actions.push(`<button class="mod" data-oid="${o.oid}" title="${T("注文修正（価格・数量）", "Modify order (price/size)")}">${T("変更", "Edit")}</button>`);
            }
            actions.push(`<button class="cxl" data-coin="${o.coin}" data-oid="${o.oid}" title="${T("注文キャンセル", "Cancel order")}">${T("取消", "Cancel")}</button>`);
          }
          const cxl = actions.join(" ");
          return `<tr>
            <td class="coin">${o.coin}</td>
            <td class="${side}">${o.side === "B" ? "Buy" : "Sell"}</td>
            <td>${fmtAnyPx(o.limitPx)}</td>
            <td>${fmtNum(o.sz, state.szDecimals[o.coin] ?? 4)}</td>
            <td>${o.reduceOnly ? '<span class="tag">RO</span>' : ""}</td>
            <td>${time}</td>
            <td>${cxl}</td>
          </tr>`;
        }).join("")
    : `<tr><td class="empty" colspan="7">${T("注文なし", "No orders")}</td></tr>`;
}

function setUser(addr, source, fromSync = false) {
  clearInterval(state.acctTimer);
  state.user = addr;
  state.userSource = addr ? source ?? state.userSource : null;
  // 2画面時はウォレット接続を共有: どちらかのペインで接続/切断したらもう片方も追従する
  // （fromSync で伝播ループを止める。相手ペインが未ロードなら ?. で黙って抜ける）
  if (FRAMED && !fromSync) {
    for (const w of Array.from(window.top.frames)) {
      if (w !== window) { try { w.setUser?.(addr, source, true); } catch { /* 相手ペイン初期化前 */ } }
    }
  }
  // 2画面時は duo.html 最上段の共有ボタンにも接続状態を反映（同 id を意図的に流用）
  const btns = [$("wallet-btn")];
  if (FRAMED) {
    const shellBtn = window.top.document.getElementById("wallet-btn");
    if (shellBtn) btns.push(shellBtn);
  }
  for (const btn of btns) {
    if (addr) {
      btn.textContent = addr.slice(0, 6) + "…" + addr.slice(-4);
      btn.classList.add("connected");
      btn.title = addr + T("（クリックで切断）", " (click to disconnect)");
    } else {
      btn.textContent = "Connect";
      btn.classList.remove("connected");
      btn.title = "";
    }
  }
  // アカウント欄の表示とポーリングは供給役ペインのみ（2画面時の共有 footer は左ペインが描画）
  if (ACCT_ON) {
    if (addr) {
      acct("account").hidden = false;
      refreshAccount();
      state.acctTimer = setInterval(refreshAccount, 5000);
    } else {
      acct("account").hidden = true;
    }
  }
  if (typeof tradeOnUser === "function") tradeOnUser();
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

// 接続状態の永続化（1画面⇔2画面の切替はページ遷移なので、これが無いと毎回切断される）。
// 保存はユーザーの明示操作（接続/切断/accountsChanged）のみで行い、?user= クエリでは書かない
function saveWalletSession(addr, source = "mm") {
  try { localStorage.setItem("hlt-user", JSON.stringify({ addr, source })); } catch { /* private mode */ }
}
function clearWalletSession() {
  try { localStorage.removeItem("hlt-user"); } catch { /* private mode */ }
}

function initSdk() {
  if (!mmsdk) {
    mmsdk = new MetaMaskSDK.MetaMaskSDK({
      dappMetadata: { name: "HL Terminal", url: location.origin },
      checkInstallationImmediately: false,
    });
    return mmsdk.init().then(() => mmsdk);
  }
  return Promise.resolve(mmsdk);
}

function wireProvider(p) {
  p.removeAllListeners?.("accountsChanged");
  p.on("accountsChanged", (a) => {
    if (a?.length) { saveWalletSession(a[0]); setUser(a[0], "mm"); closeModal(); }
    else { clearWalletSession(); setUser(null); }
  });
}

// MetaMask SDK: 拡張があればそれを使い、無ければ SDK が QR モーダルを表示して
// スマホの MetaMask アプリと本セッションを張る（app.hyperliquid.xyz と同じ方式）
async function connectMetaMask() {
  const btn = $("cm-mm");
  btn.disabled = true;
  btn.textContent = T("接続待ち…", "Connecting…");
  try {
    await initSdk();
    mmProvider = mmsdk.getProvider();
    // request の解決を待たずに済むよう先に登録（承認がスマホ側で遅れて完了した場合の保険）
    wireProvider(mmProvider);
    const accounts = await mmProvider.request({ method: "eth_requestAccounts" });
    if (accounts?.length) {
      saveWalletSession(accounts[0]);
      setUser(accounts[0], "mm");
      closeModal();
    }
  } catch (e) {
    console.error("MetaMask connect:", e);
  } finally {
    btn.disabled = false;
    btn.textContent = T("MetaMask で接続", "Connect with MetaMask");
  }
}

// 起動時の再接続: 前回 mm 接続なら SDK セッションを静かに張り直す。
// eth_requestAccounts と違い eth_accounts は承認 UI/QR を一切出さない —
// セッションが生きていなければ空が返るだけなので、そのときは保存を破棄して未接続に戻す
async function restoreWallet() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("hlt-user")); } catch { /* broken JSON */ }
  if (!saved?.addr) return;
  if (saved.source === "watch") { setUser(saved.addr, "watch", true); return; }
  // 表示は先に復元（fromSync: 各ペインが自力で復元するので伝播不要）。agent 鍵もこの時点で載る
  setUser(saved.addr, "mm", true);
  // SDK の再接続は供給役（1画面 / 左ペイン）のみ — 現行の接続導線と同じ（右ペインは表示+agent のみ）
  if (FRAMED && PANE === "2") return;
  try {
    await initSdk();
    const p = mmsdk.getProvider();
    wireProvider(p);
    const accounts = await p.request({ method: "eth_accounts" });
    if (accounts?.length) {
      mmProvider = p;
      if (accounts[0].toLowerCase() !== saved.addr.toLowerCase()) {
        saveWalletSession(accounts[0]);
        setUser(accounts[0], "mm");
      }
    } else {
      clearWalletSession();
      setUser(null); // 右ペインへも伝播して未接続表示に戻す
    }
  } catch (e) {
    console.warn("wallet session restore:", e);
    clearWalletSession();
    setUser(null);
  }
}

function disconnectWallet() {
  try { mmsdk?.terminate(); } catch { /* no active SDK session */ }
  clearWalletSession();
  setUser(null);
}

function connectWatch() {
  const addr = prompt(T("表示するアドレスを入力（ウォッチモード）:", "Enter address to watch:"));
  if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr.trim())) {
    saveWalletSession(addr.trim().toLowerCase(), "watch");
    setUser(addr.trim().toLowerCase(), "watch");
    closeModal();
  } else if (addr) {
    alert(T("アドレスの形式が不正です", "Invalid address format"));
  }
}

$("wallet-btn").addEventListener("click", () => {
  if (state.user) disconnectWallet();
  else openModal();
});
// 2画面時のウォレット/設定ボタンは duo.html 最上段の共有コントロールに一本化
// （クリックは左ペインへ委譲される）。ペイン内は1段目（#topbar-acct）ごと隠し、
// Trade 欄の未接続ゲートのボタンも出さない（trade.js 参照 — 接続導線は最上段の1個だけ）
if (FRAMED) $("topbar-acct").hidden = true;
$("cm-close").addEventListener("click", closeModal);
$("connect-modal").addEventListener("click", (e) => { if (e.target.id === "connect-modal") closeModal(); });
$("cm-mm").addEventListener("click", connectMetaMask);
$("cm-watch").addEventListener("click", connectWatch);

// ---------- switching ----------

async function switchTo(coin, interval) {
  for (const s of subs(state.coin, state.interval)) wsSend("unsubscribe", s);
  const coinChanged = coin !== state.coin;
  state.coin = coin;
  state.interval = interval;
  // 2画面時はペインごとに銘柄を記憶（設定保存等での reload 後も復元される）
  if (FRAMED) localStorage.setItem(`hlt-coin:p${PANE}`, coin);
  $("asks").innerHTML = $("bids").innerHTML = $("trades").innerHTML = "";
  state.bookTime = 0; // 銘柄が変わるので板の鮮度ガードをリセット
  await loadCandles();
  for (const s of subs(coin, interval)) wsSend("subscribe", s);
  if (coinChanged && typeof tradeOnCoinChange === "function") tradeOnCoinChange();
}

// 銘柄の絞り込み検索: 検索欄への入力でプルダウンの候補を絞る（プルダウン単独でも従来どおり使える）
{
  const filterEl = $("coin-filter");
  const sel = $("coin-select");

  // 前方一致を優先し、次いで部分一致（各グループ内は出来高順のまま）。
  // API 名（"xyz:CL" とその ":" 以降）と表示名（"WTIOIL"）の両方を一致対象にする。
  // 部分一致は名前のみ（"-PERP" や "(xyz)" を含めると全銘柄が一致してしまう）
  function matches(q) {
    const Q = q.trim().toUpperCase();
    if (!Q) return state.coinList.slice();
    const pre = [], sub = [];
    for (const c of state.coinList) {
      const keys = [c, c.split(":").pop(), (state.coinLabels[c] ?? "").replace(/ \(.+\)$/, "")]
        .map((s) => s.toUpperCase());
      if (keys.some((k) => k.startsWith(Q) || `${k}-PERP`.startsWith(Q))) pre.push(c);
      else if (keys.some((k) => k.includes(Q))) sub.push(c);
    }
    return pre.concat(sub);
  }

  // 選択確定後は検索をリセットして全銘柄のプルダウンに戻す
  function resetFilter() {
    filterEl.value = "";
    setCoinOptions(state.coinList, state.coin);
  }

  filterEl.addEventListener("input", () => setCoinOptions(matches(filterEl.value), state.coin));
  filterEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // 先頭候補（プルダウンに表示中の銘柄）に切替
      if (sel.value && sel.value in state.coinLabels) {
        if (sel.value !== state.coin) switchTo(sel.value, state.interval);
        resetFilter();
        filterEl.blur();
      }
    } else if (e.key === "Escape") {
      resetFilter();
      filterEl.blur();
    }
  });

  sel.addEventListener("change", async (e) => {
    await switchTo(e.target.value, state.interval);
    resetFilter(); // 絞り込み中に選んだ場合も次回は全銘柄に戻す
  });
}

for (const btn of document.querySelectorAll("#intervals button")) {
  btn.addEventListener("click", () => {
    document.querySelector("#intervals .active")?.classList.remove("active");
    btn.classList.add("active");
    switchTo(state.coin, btn.dataset.iv);
  });
}

// ---------- 2画面切替ボタン ----------
// PC（スマホ幅 900px 超）は既定で2画面（index.html 冒頭のリダイレクト）。ここは行き来のボタン:
// 単独表示では「2画面」、ペイン内では「1画面」。選択は localStorage hlt-view に記憶され、
// 次回アクセス時の既定（リダイレクトの有無）になる
{
  const btn = $("split-btn");
  const pc = matchMedia("(min-width: 901px)");
  const render = () => {
    // ペイン内では出さない（「1画面」は duo.html 最上段の共有ボタンにある）
    if (FRAMED) { btn.hidden = true; return; }
    btn.textContent = T("2画面", "Split");
    btn.title = T("左右2画面で別銘柄を表示", "Show two panes side by side");
    btn.hidden = !pc.matches;
  };
  btn.addEventListener("click", () => {
    localStorage.setItem("hlt-view", "duo");
    location.href = "duo.html";
  });
  pc.addEventListener("change", render);
  render();
}

// 2画面時: 片方のペインで API 接続先を変更・保存したら、もう片方も追従して再読込する
// （storage イベントは他ウィンドウの変更でのみ発火するので、自分は二重 reload しない）
window.addEventListener("storage", (e) => {
  if (e.key === "hlt-api" || e.key === "hlt-lang") location.reload();
});

// ---------- API settings modal ----------

function openSettings() {
  const mode = NET.custom ? "custom" : (NETS[API_CFG.mode] ? API_CFG.mode : "mainnet");
  document.querySelector(`input[name="api-mode"][value="${mode}"]`).checked = true;
  $("api-http").value = API_CFG.http || "";
  $("api-ws").value = API_CFG.ws || "";
  $("api-custom-mainnet").checked = API_CFG.mainnet !== false;
  $("settings-modal").hidden = false;
}

function saveSettings() {
  const mode = document.querySelector('input[name="api-mode"]:checked').value;
  const cfg = { mode };
  if (mode === "custom") {
    cfg.http = $("api-http").value.trim();
    cfg.ws = $("api-ws").value.trim();
    cfg.mainnet = $("api-custom-mainnet").checked;
    if (!/^https?:\/\/.+/.test(cfg.http)) { alert(T("HTTP URL の形式が不正です（例: https://api.example.com）", "Invalid HTTP URL (e.g. https://api.example.com)")); return; }
    if (cfg.ws && !/^wss?:\/\/.+/.test(cfg.ws)) { alert(T("WS URL の形式が不正です（例: wss://api.example.com/ws）", "Invalid WS URL (e.g. wss://api.example.com/ws)")); return; }
  }
  localStorage.setItem("hlt-api", JSON.stringify(cfg));
  location.reload(); // 接続・購読・アカウント状態を丸ごと作り直すため再読込が最も安全
}

$("settings-btn").addEventListener("click", openSettings);
$("sm-save").addEventListener("click", saveSettings);
$("sm-cancel").addEventListener("click", () => { $("settings-modal").hidden = true; });
$("settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") $("settings-modal").hidden = true; });

function renderNetBadge() {
  const badge = $("net-badge");
  const isDefault = !NET.custom && !NET.alt && NET.isMainnet;
  badge.hidden = isDefault;
  if (!isDefault) {
    badge.textContent = NET.custom ? `CUSTOM (${NET.isMainnet ? "Mainnet" : "Testnet"})` : NET.label.toUpperCase();
    badge.className = NET.isMainnet ? "net-custom" : "net-testnet";
    badge.title = NET.http;
  }
}

// puppeteer 検証用の内部ハンドル（トップレベル const/let は window に乗らず外から見えないため。
// UI・機能からは参照しないこと）
window.__hlt = {
  get chart() { return chart; },
  get volChart() { return volChart; },
  get candleSeries() { return candleSeries; },
  state,
  get mmProvider() { return mmProvider; },
  set mmProvider(p) { mmProvider = p; }, // E2E でフェイクプロバイダを差し込む用
  get mmsdk() { return mmsdk; },
  set mmsdk(s) { mmsdk = s; }, // E2E でフェイク SDK を差し込む用（restoreWallet の検証）
};

// ---------- 表示言語の適用と切替ボタン ----------

// EN のときだけ静的 DOM の文言を差し替える（HTML の原文は日本語 = 既定）。
// 動的に生成・更新される文字列は各所の T() が担当する
function applyLang() {
  document.documentElement.lang = LANG === "en" ? "en" : "ja";
  const langBtn = $("lang-btn");
  if (langBtn) {
    // 表記は現在の言語（"JP" ⇔ "EN" の2状態で入れ替わる — ユーザー指定 2026-07-15）
    langBtn.textContent = LANG === "en" ? "EN" : "JP";
    langBtn.title = T("表示言語の切替", "Language");
    langBtn.addEventListener("click", () => {
      localStorage.setItem("hlt-lang", LANG === "en" ? "jp" : "en");
      location.reload();
    });
  }
  if (LANG !== "en") return;
  const t = (sel, txt) => { const el = document.querySelector(sel); if (el) el.textContent = txt; };
  const ttl = (sel, txt) => { const el = document.querySelector(sel); if (el) el.title = txt; };
  // topbar
  const cf = $("coin-filter");
  cf.placeholder = "Search";
  cf.title = "Filter symbols";
  ttl("#coin-select", "Symbol");
  ttl("#ind-ma", "Moving averages (20/50)");
  ttl("#ind-bb", "Bollinger Bands (20, 2σ)");
  ttl("#ind-tl", "Auto trend channels");
  ttl("#settings-btn", "API endpoint settings");
  ttl("#conn", "WebSocket status");
  // 発注フォーム
  t('#tf-side [data-side="buy"]', "Buy");
  t('#tf-side [data-side="sell"]', "Sell");
  t('#tf-type [data-type="limit"]', "Limit");
  t('#tf-type [data-type="market"]', "Market");
  t(".tf-lev-label", "Lev");
  ttl("#tf-lev", "Leverage");
  t("#tf-lev-set", "Set");
  const rowLabels = document.querySelectorAll(".tf-rows .tf-row > span:first-child");
  if (rowLabels[0]) rowLabels[0].textContent = "Price";
  if (rowLabels[1]) rowLabels[1].textContent = "Size";
  $("tf-px").placeholder = FRAMED ? "Price" : "0.0";
  $("tf-sz").placeholder = FRAMED ? "Size" : "0.0";
  // アカウント欄サマリ（1画面時。2画面の共有欄は duo.html のインラインスクリプトが担当）
  const acctLabels = ["Equity", "Available to Trade", "Withdrawable", "Margin Used", "uPnL"];
  document.querySelectorAll("#acct-summary .stat .label").forEach((n, i) => { if (acctLabels[i]) n.textContent = acctLabels[i]; });
  t("#ac-deposit", "Deposit");
  ttl("#ac-deposit", "Send USDC on Arbitrum to the bridge (min 5 USDC)");
  t("#ac-withdraw-btn", "Withdraw");
  ttl("#ac-withdraw-btn", "Withdraw USDC to Arbitrum (fee 1 USDC)");
  // 設定モーダル
  t("#settings-box h3", "API endpoint");
  const names = [
    "Official Mainnet",
    "Official Testnet",
    "Alt API-UI (official web-UI pool, separate rate limit)",
    "Alt API2 (official alternate pool)",
    "Custom (keyed third-party — Chainstack, QuickNode, etc.)",
  ];
  document.querySelectorAll("#settings-box .sm-name").forEach((n, i) => { if (names[i]) n.textContent = names[i]; });
  $("api-ws").placeholder = "wss://api.example.com/ws (derived from HTTP if empty)";
  t("#sm-custom-net-txt", " Mainnet data (used to pick the signing chain)");
  t(".sm-note", "Saving reloads the page. The endpoint is stored in localStorage and works as a fallback during official API outages.");
  t("#sm-cancel", "Cancel");
  t("#sm-save", "Save & reload");
  // 接続モーダル
  t("#connect-box h3", "Connect Wallet");
  t("#cm-mm", "Connect with MetaMask");
  t("#cm-watch", "Enter address (watch mode)");
  t("#cm-note", "Without the extension a QR code is shown — scan and approve in the MetaMask mobile app.");
  ttl("#cm-close", "Close");
}

// ---------- boot ----------

(async () => {
  // 2画面ペインは前回の銘柄を復元（実在しない銘柄なら loadCoins が先頭銘柄へフォールバック）
  if (FRAMED) {
    const saved = localStorage.getItem(`hlt-coin:p${PANE}`);
    if (saved) state.coin = saved;
  }
  applyLang();
  setupChart();
  applyIndicatorVisibility();
  renderNetBadge();
  await loadCoins();
  await loadCandles();
  loadTicker(); // 初期値。以後は WS activeAssetCtx で更新
  connect();
  demandConnect();
  setInterval(applyTlWatch, 30000); // 実需フローの追記を定期更新
  const qUser = new URLSearchParams(location.search).get("user");
  if (qUser && /^0x[0-9a-fA-F]{40}$/.test(qUser)) setUser(qUser.toLowerCase(), "watch"); // クエリ指定は保存しない（テスト用の一時表示）
  else restoreWallet(); // 前回の接続を復元（1画面⇔2画面切替・リロードで切断されないように）
})();
