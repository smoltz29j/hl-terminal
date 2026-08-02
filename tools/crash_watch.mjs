// 急落警報の常設監視（cron 用）— app.js と同じ判定をヘッドレスで実行し、
// 状態変化時だけデスクトップ通知 + ログ。最大の目的 = 急落の早期発見
//（ユーザー方針 2026-07-26: 「見つけたらすぐ指摘、騙しと判断したらそれも指摘」）。
//
//   node tools/crash_watch.mjs          # 判定 → 状態ファイル更新・変化時に notify-send
//   node tools/crash_watch.mjs --peek   # 判定だけ（状態ファイルを書かない。Claude セッション用）
//
// TL ロジックは app.js から実行時に抜き出して評価する（二重実装を避け、
// app.js 側のチューニングに自動追従する）。判定は日足・公式 mainnet API。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(DIR, "..", "app.js");
const STATE_FILE = join(DIR, "crash_watch_state.json");
const PEEK = process.argv.includes("--peek");

// ---- app.js から auto trend channels 一式を抽出 ----
const app = readFileSync(APP_JS, "utf8");
const beg = app.indexOf("// ---------- auto trend channels");
const end = app.indexOf("function ensureTlSeries");
if (beg < 0 || end < 0) throw new Error("app.js の TL マーカーが見つからない");
const core = new Function(
  app.slice(beg, end).replace(/^let tlSeries.*$/m, "") +
  `\nreturn { findPivots, trendSegments, fitChannel, coarseSegments, refineSegment, touchFit,
    TL_SCALES, TL_MIN_SUB, TL_RECENT_WIN, TL_RECENT_CRASH, TL_FAST_BARS,
    TL_MAX_CHANNELS, TL_LEG_WIDTH, TL_LEG_RUN, TL_COARSE_MIN };`
)();

// ---- データ取得 ----
async function fetchCandles() {
  const end = Date.now();
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: {
      coin: "BTC", interval: "1d", startTime: end - 310 * 86400000, endTime: end } }),
    signal: AbortSignal.timeout(20000), // ハングすると cron 起動の node が積み重なる
  });
  if (!res.ok) throw new Error(`candleSnapshot ${res.status}`);
  return (await res.json()).slice(-300);
}

// realtime_demand の snap を1回だけ取得（python websockets 経由。落ちていれば null）
function fetchDemand() {
  try {
    const out = execFileSync("python3", ["-c", `
import asyncio, json, websockets
async def main():
    async with websockets.connect("ws://127.0.0.1:8765/ws", open_timeout=4, max_size=None) as ws:
        print(await asyncio.wait_for(ws.recv(), 5))
asyncio.run(main())
`], { timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024 }); // snap は数MB（7200点）
    return JSON.parse(out).history || null;
  } catch { return null; }
}

// app.js demandDir と同じ5分テイカーフロー判定（1=買/-1=売/0=中立/null=不明）
function demandDir(points, keys) {
  if (!points || !points.length) return null;
  const lastT = points[points.length - 1].t;
  if (Date.now() / 1000 - lastT > 30) return null;
  let buy = 0, sell = 0, oldest = lastT;
  for (let i = points.length - 1; i >= 0 && lastT - points[i].t < 300; i--) {
    for (const k of keys) {
      const v = points[i][k];
      if (v) { buy += v[2]; sell += v[3]; }
    }
    oldest = points[i].t;
  }
  if (lastT - oldest < 60 || buy + sell < 0.05) return 0;
  const r = (buy - sell) / (buy + sell);
  return r >= 0.12 ? 1 : r <= -0.12 ? -1 : 0;
}

// ---- computeChannels + computeTlSignals 相当（描画抜き）----
function analyze(ks) {
  const hs = ks.map((k) => Number(k.h));
  const ls = ks.map((k) => Number(k.l));
  const cs = ks.map((k) => Number(k.c));
  const n = ks.length;
  const C = core;

  const found = [];
  for (const s of C.coarseSegments(hs, ls, cs)) found.push({ ...s, k: 99 });
  for (const sc of C.TL_SCALES) {
    for (const s of C.trendSegments(C.findPivots(hs, ls, sc.k), n)) {
      if (s.b - s.a + 1 < sc.minBars) continue;
      for (const r of C.refineSegment(s.a, s.b, hs, ls, cs, 4)) {
        if (r.b - r.a + 1 >= C.TL_MIN_SUB) found.push({ ...r, k: sc.k });
      }
    }
  }
  const w0 = n - Math.min(C.TL_RECENT_WIN, n);
  let iMin = w0, iMax = w0;
  for (let i = w0; i < n; i++) {
    if (ls[i] < ls[iMin]) iMin = i;
    if (hs[i] > hs[iMax]) iMax = i;
  }
  for (const a of new Set([iMin, iMax])) {
    if (n - a >= C.TL_MIN_SUB) found.push({ a, b: n - 1, k: 1 });
  }
  found.sort((x, y) => y.k - x.k || y.b - x.b);
  const coarse = found.filter((s) => s.k === 99);
  const segs = [];
  for (const s of found) {
    if (segs.length >= C.TL_MAX_CHANNELS) break;
    const len = s.b - s.a + 1;
    if (segs.some((t) => Math.abs(t.a - s.a) + Math.abs(t.b - s.b) < len * 0.3)) continue;
    if (s.k !== 99 && s.b < n - 3) {
      if (n - 1 - s.b > C.TL_RECENT_CRASH) continue;
      const fs = C.fitChannel(s.a, s.b, hs, ls, cs);
      const overlap = (c) => Math.min(c.b, s.b) - Math.max(c.a, s.a);
      const c = coarse.filter((c) => overlap(c) > 0).sort((x, y) => overlap(y) - overlap(x))[0];
      if (c) {
        const fc = C.fitChannel(c.a, c.b, hs, ls, cs);
        const w = fs.up - fs.dn;
        const tightLeg = w <= C.TL_LEG_WIDTH * (fc.up - fc.dn) &&
          Math.abs(fs.m) * len >= C.TL_LEG_RUN * w;
        if (!tightLeg && Math.abs(fs.m - fc.m) < (fc.up - fc.dn) / C.TL_FAST_BARS) continue;
      }
    }
    segs.push(s);
  }

  for (const s of segs) {
    s.fit = C.touchFit(s.a, s.b, hs, ls, cs);
    const { m, c, up, dn } = s.fit;
    const tol = (up - dn) * 0.2; // TL_FIT_TOL
    const y = (i, off) => m * (i - s.a) + c + off;
    const fits = (i) => hs[i] <= y(i, up) + tol && ls[i] >= y(i, dn) - tol;
    const len = s.b - s.a + 1;
    let L = s.a, R = s.b;
    while (L > Math.max(0, s.a - len) && fits(L - 1)) L--;
    while (R < Math.min(n - 1, s.b + len) && fits(R + 1)) R++;
    s.L = L; s.R = R;
  }

  // BB(20,2)
  const bbUp = [], bbLo = [];
  for (let i = 0; i < n; i++) {
    if (i < 19) { bbUp.push(NaN); bbLo.push(NaN); continue; }
    let sum = 0, sq = 0;
    for (let j = i - 19; j <= i; j++) { sum += cs[j]; sq += cs[j] * cs[j]; }
    const mean = sum / 20, sd = Math.sqrt(Math.max(0, sq / 20 - mean * mean));
    bbUp.push(mean + 2 * sd); bbLo.push(mean - 2 * sd);
  }
  const live = segs.filter((s) => s.k === 99 && (s.R ?? s.b) >= n - 1)
    .sort((x, y) => x.a - y.a)[0];
  let liveUp = -1, liveDn = -1;
  if (live) {
    const { m, c, up, dn } = live.fit;
    const y = (i, off) => m * (i - live.a) + c + off;
    for (let i = Math.max(live.L ?? live.a, 20); i <= n - 1; i++) {
      if (bbLo[i] < y(i, dn) && i > liveDn) liveDn = i;
      if (bbUp[i] > y(i, up) && i > liveUp) liveUp = i;
    }
  }
  // 局面（SMA200）。データが200本未満でも NaN 化して黙って bull に倒れないよう手当て
  const m200 = Math.min(200, n);
  let s200 = 0;
  for (let i = n - m200; i < n; i++) s200 += cs[i];
  const regime = cs[n - 1] < s200 / m200 ? "bear" : "bull";

  let stage = "none";
  if (live) {
    const f = live.fit, w = f.up - f.dn, age = n - live.a;
    if (age >= 30 && f.m > -w / 50 && f.m < w / 25) {
      stage = "calm";
      if (liveDn >= 0 && n - 1 - liveDn <= 5) stage = "break";
      else if (liveUp >= 0 && n - 1 - liveUp <= 15) stage = "hot";
    }
  }

  // 右端の上昇レッグ（ユーザーが見る「平行線」）の割れ日数
  let legBreakDays = 0, legSlope = null;
  const leg = segs.filter((s) => s.k !== 99 && s.k > 1 && s.b >= n - 1 && s.fit.m > 0)
    .sort((x, y) => x.a - y.a)[0];
  if (leg) {
    legSlope = leg.fit.m;
    const y = (i) => leg.fit.m * (i - leg.a) + leg.fit.c + leg.fit.dn;
    let i = n - 1;
    while (i > leg.a && ls[i] < y(i)) { legBreakDays++; i--; }
  }
  return { close: cs[n - 1], stage, regime, legBreakDays, legSlope };
}

// ---- レベル判定（app.js updateCrashAlert と同一）+ メッセージ ----
// このツールの存在意義は「急落を見逃さない」こと — API 障害でこのプロセス自体が
// 未処理例外で沈黙すると本末転倒なので、失敗はログに残して終了コードで示す
let ks;
try {
  ks = await fetchCandles();
} catch (e) {
  console.error(`${new Date().toISOString()} crash_watch: candleSnapshot 取得失敗 — ${e?.message ?? e}`);
  process.exit(1);
}
const a = analyze(ks);
const hist = fetchDemand();
const spot = demandDir(hist, ["bspot", "cspot"]);
const perp = demandDir(hist, ["bperp"]);
let level = 0;
if (a.stage === "break") level = a.regime === "bear" && (spot === null || spot <= 0) ? 3 : 2;
else if (a.stage === "hot" && a.regime === "bear") level = 2;
else if (a.regime === "bear") level = 1;

const flow = (d) => (d === null ? "?" : d > 0 ? "買" : d < 0 ? "売" : "中立");
const stageJp = { break: "床破断▼", hot: "天井過熱▲", calm: "監視中", none: "対象チャネルなし" };
let text = `${stageJp[a.stage]} · ${a.regime === "bear" ? "弱気" : "強気"}局面` +
  ` · 実需5分: 現物${flow(spot)}/perp${flow(perp)}` +
  (a.legBreakDays > 0 ? ` · 上昇チャネル割れ${a.legBreakDays}日目` : "");
if (a.stage === "break") {
  text += spot > 0 ? "（⚠現物は買い — 騙しの可能性）" : spot < 0 ? "（現物も売り — 信頼度高）" : "";
}

const prev = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
const legBroken = a.legBreakDays > 0;
const changed = !prev || prev.stage !== a.stage || prev.level !== level || prev.legBroken !== legBroken;
// 騙しの事後判定: 破断から break を離脱し、価格が戻っている
const fakeout = prev && prev.stage === "break" && a.stage !== "break" && a.close > prev.close;

const verdict = {
  t: new Date().toISOString(), close: a.close, stage: a.stage, regime: a.regime,
  level, spot, perp, legBroken, legBreakDays: a.legBreakDays, changed, fakeout: !!fakeout, text,
};
console.log(JSON.stringify(verdict));

if (!PEEK) {
  writeFileSync(STATE_FILE, JSON.stringify({ ...verdict, changed: undefined }));
  if (changed || fakeout) {
    const head = fakeout ? "HL: 破断→回復 — 騙しだった可能性"
      : level >= 3 ? "🚨 HL 急落警報 Lv3" : level >= 2 ? "⚠ HL 急落警戒 Lv2" : "HL 監視状態変化";
    try {
      // 引数配列で渡す（シェル文字列組み立ては将来文言に引用符が入ると壊れる）
      execFileSync("notify-send", ["-u", level >= 3 ? "critical" : "normal", head, text], {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0",
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ||
            `unix:path=/run/user/${process.getuid()}/bus` },
        timeout: 5000,
      });
    } catch { /* デスクトップ不在でも判定・ログは残す */ }
  }
}
