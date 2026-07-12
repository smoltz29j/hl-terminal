"use strict";

// ---------- API 接続先（設定で公式 Mainnet / Testnet / カスタムを切替） ----------

const NETS = {
  mainnet: { label: "Mainnet", http: "https://api.hyperliquid.xyz", ws: "wss://api.hyperliquid.xyz/ws", isMainnet: true },
  testnet: { label: "Testnet", http: "https://api.hyperliquid-testnet.xyz", ws: "wss://api.hyperliquid-testnet.xyz/ws", isMainnet: false },
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
  interval: "1d",
  ws: null,
  wsReady: false,
  reconnectDelay: 1000,
  szDecimals: {},        // coin -> size decimals
  assetIds: {},          // coin -> asset id（meta.universe の元 index。発注に使用）
  pxDecimals: 1,         // decimals of the current coin's prices (derived from data)
  lastCandleT: 0,
  candles: [],           // 現在銘柄・現在足の生ローソク（指標計算用）
  markPx: 0,             // 現在銘柄の mark（成行の基準価格）
  user: null,            // connected/watched wallet address
  userSource: null,      // "mm"（MetaMask 接続）| "watch"
  acctTimer: null,
  openOrders: [],        // frontendOpenOrders の生データ（oid → 注文詳細の参照用）
  positions: [],         // clearinghouseState のポジション（クローズ操作の参照用）
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
    .map((u, i) => ({ ...u, ctx: ctxs[i], assetId: i }))
    .filter((u) => !u.isDelisted)
    .sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm));
  const sel = $("coin-select");
  sel.innerHTML = "";
  for (const c of coins) {
    state.szDecimals[c.name] = c.szDecimals;
    state.assetIds[c.name] = c.assetId;
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = `${c.name}-PERP`;
    sel.appendChild(opt);
  }
  // 接続先によっては既定銘柄が無いことがある（testnet 等）→ 出来高最大の銘柄へ
  if (!(state.coin in state.assetIds)) state.coin = coins[0]?.name ?? state.coin;
  sel.value = state.coin;
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
        regimeTag = regime === "bear" ? " · 弱気局面" : " · 強気局面(破断は騙し多め)";
      }
      let cls = "watch-calm", stage = "calm", txt = "監視中（▲/▼ 待ち）";
      if (liveDn >= 0 && n1 - liveDn <= 5) {
        const ago = n1 - liveDn === 0 ? "本日" : `${n1 - liveDn}日前`;
        cls = "watch-break"; stage = "break"; txt = `床破断 ▼ ${ago} — 過去2回はここから急落`;
      } else if (liveUp >= 0 && n1 - liveUp <= 15) {
        cls = "watch-hot"; stage = "hot"; txt = `天井過熱 ▲ ${n1 - liveUp}日前 — 床破断(▼)を警戒`;
      }
      state.tlWatch = { cls, stage, regime, text: `パターン監視: ${d0.getMonth() + 1}/${d0.getDate()}〜 ${age}日目 · ${txt}${regimeTag}` };
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
    return u || `ws://${location.hostname}:8765/ws`;
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
    const lb = { "1": "買", "0": "中立", "-1": "売" };
    text += ` · 実需5分: 現物${lb[spot]}/perp${lb[perp]}`;
    if (w.cls === "watch-break") {
      text += spot > 0 ? "（⚠ 現物は買い — 騙しの可能性）" : spot < 0 ? "（現物も売り — 信頼度高）" : "";
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
    const spotTxt = spot === null ? "" : spot > 0 ? " · 実需: 現物買い(騙し注意)" : spot < 0 ? " · 実需: 現物も売り" : " · 実需: 中立";
    el.textContent = lv >= 3
      ? `🚨 急落警報 — 床破断▼ · 弱気局面${spotTxt}`
      : `⚠ 急落警戒 — ${w.stage === "break" ? "床破断▼" : "天井過熱▲"}${spotTxt}`;
    el.className = lv >= 3 ? "alert-3" : "alert-2";
    el.hidden = false;
  } else {
    el.hidden = true;
  }
  // レベル3はブラウザ通知+ビープ（日付×レベルで重複抑止 — 再読込では鳴らさない）
  if (lv >= 3) {
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
  if (IND_CFG.tl) items.push([TL_COLOR, "チャネル (自動)"], [TL_EXT_COLOR, "チャネル延長"]);
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
        const close = canTrade && p.coin in state.assetIds
          ? `<button class="close-pos" data-coin="${p.coin}" title="成行でクローズ（Reduce Only）">クローズ</button>` : "";
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
    : `<tr><td class="empty" colspan="8">ポジションなし</td></tr>`;

  $("orders").tBodies[0].innerHTML = orders.length
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
              actions.push(`<button class="mod" data-oid="${o.oid}" title="注文修正（価格・数量）">変更</button>`);
            }
            actions.push(`<button class="cxl" data-coin="${o.coin}" data-oid="${o.oid}" title="注文キャンセル">取消</button>`);
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
    : `<tr><td class="empty" colspan="7">注文なし</td></tr>`;
}

function setUser(addr, source) {
  clearInterval(state.acctTimer);
  state.user = addr;
  state.userSource = addr ? source ?? state.userSource : null;
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
      if (a?.length) { setUser(a[0], "mm"); closeModal(); }
      else setUser(null);
    });
    const accounts = await mmProvider.request({ method: "eth_requestAccounts" });
    if (accounts?.length) {
      setUser(accounts[0], "mm");
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
    setUser(addr.trim().toLowerCase(), "watch");
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
  const coinChanged = coin !== state.coin;
  state.coin = coin;
  state.interval = interval;
  $("asks").innerHTML = $("bids").innerHTML = $("trades").innerHTML = "";
  await loadCandles();
  for (const s of subs(coin, interval)) wsSend("subscribe", s);
  if (coinChanged && typeof tradeOnCoinChange === "function") tradeOnCoinChange();
}

$("coin-select").addEventListener("change", (e) => switchTo(e.target.value, state.interval));

for (const btn of document.querySelectorAll("#intervals button")) {
  btn.addEventListener("click", () => {
    document.querySelector("#intervals .active")?.classList.remove("active");
    btn.classList.add("active");
    switchTo(state.coin, btn.dataset.iv);
  });
}

// ---------- API settings modal ----------

function openSettings() {
  const mode = NET.custom ? "custom" : (NET.isMainnet ? "mainnet" : "testnet");
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
    if (!/^https?:\/\/.+/.test(cfg.http)) { alert("HTTP URL の形式が不正です（例: https://api.example.com）"); return; }
    if (cfg.ws && !/^wss?:\/\/.+/.test(cfg.ws)) { alert("WS URL の形式が不正です（例: wss://api.example.com/ws）"); return; }
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
  const isDefault = !NET.custom && NET.isMainnet;
  badge.hidden = isDefault;
  if (!isDefault) {
    badge.textContent = NET.custom ? `CUSTOM (${NET.isMainnet ? "Mainnet" : "Testnet"})` : NET.label.toUpperCase();
    badge.className = NET.isMainnet ? "net-custom" : "net-testnet";
    badge.title = NET.http;
  }
}

// ---------- boot ----------

(async () => {
  setupChart();
  applyIndicatorVisibility();
  renderNetBadge();
  await loadCoins();
  await loadCandles();
  connect();
  demandConnect();
  setInterval(applyTlWatch, 30000); // 実需フローの追記を定期更新
  const qUser = new URLSearchParams(location.search).get("user");
  if (qUser && /^0x[0-9a-fA-F]{40}$/.test(qUser)) setUser(qUser.toLowerCase(), "watch");
})();
