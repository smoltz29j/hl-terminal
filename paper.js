"use strict";

// ペーパートレード（仮想発注）モード。localStorage hlt-paper="1" で有効（PAPER 定数は app.js、
// 切替は最上段の Paper ボタン → reload）。実 API は /info（allMids）しか叩かず、/exchange へは
// 一切送らない。口座状態は localStorage `hlt-paper:acct:<net>` に保存し、2画面の両ペインで共有する
// （右ペインは発注だけ行い、描画・約定判定・清算判定は供給役=左ペインの 5 秒ティックが担う）。
//
// 約定モデル（意図的に単純。実売買より少し有利側の近似であることを忘れないこと）:
//   成行  = 現在 mark で全量即時約定（taker 手数料）。板の厚み・スリッページは見ない
//   指値  = 発注時に mark と交差していれば mark で即時約定（taker）。そうでなければ板に残り、
//           5 秒ごとの mark 更新で「買い: mark ≤ 指値 / 売り: mark ≥ 指値」になった時点で
//           指値価格で全量約定（maker）。キュー優先度・部分約定は考慮しない
//   証拠金 = クロス固定（Isolated は非対応。UI のモード切替は隠す）。
//           必要証拠金 = 想定元本 ÷ レバレッジ、維持証拠金 = 想定元本 ÷ (2×maxLev)（HL と同じ規則）。
//           板に残る非 Reduce-Only 注文の必要証拠金も余力から予約する
//   清算  = 口座価値（残高+含み損益）< 維持証拠金合計 で全ポジションを mark で強制クローズ、注文全取消
//   funding = 毎時 0 分（HL と同じ）に建玉へ資金調達料を反映。料率は /info fundingHistory の実値
//           （時間あたり率。正なら Long が払い Short が受け取る）、支払 = −szi × 価格 × 率。
//           価格は HL ではオラクル価格だが、ここでは「その時刻の 1h 足終値」（直近 2 分以内の
//           精算は現在 mark）で近似する。建玉中にサイズが変わった時間帯は精算時点のサイズで計算。
//           ブラウザを閉じていた期間も次回ティックで履歴から追い付く（1 銘柄 500 時間 ≒ 20 日が上限）
//   対象銘柄は実発注と同じ state.assetIds 登録済み銘柄（builder DEX は mids の取得経路が別のため除外）

const PAPER_INIT_CASH = 100000;   // USDC
const PAPER_TAKER_FEE = 0.00045;  // HL 基本ティア
const PAPER_MAKER_FEE = 0.00015;
const PAPER_DEFAULT_LEV = 10;     // 銘柄の maxLev がこれ未満なら maxLev
const PAPER_MAX_FILLS = 200;      // 約定履歴の保存上限
const PAPER_MIDS_STALE_MS = 15000;
const PAPER_FUNDING_RETRY_MS = 60000; // funding 履歴の再取得間隔（精算直後は API 反映にラグがある）
const PAPER_MAX_FUNDINGS = 200;       // funding 精算履歴の保存上限（約定履歴とは別枠）
const PAPER_KEY = `hlt-paper:acct:${NET.isMainnet ? "mainnet" : "testnet"}`;

const paper = {
  mids: {}, midsTs: 0,
  // クラウド版（CLOUD）の同期状態。localStorage は常にキャッシュとして使い（paperLoad は同期関数の
  // まま）、サーバー `/api/paper/<net>` と rev 付きで同期する。cloudReady になるまで発注は
  // 受け付けない（tradeReady）— 初期ロード前に空口座を PUT してサーバー側を潰さないため
  cloudReady: !CLOUD, dirty: false, syncing: null,
  fundingChk: {},  // coin -> 最後に fundingHistory を問い合わせた時刻（スロットリング）
};
const PAPER_REV_KEY = PAPER_KEY + ":rev";

function paperNew(cash = PAPER_INIT_CASH) {
  return {
    v: 1, cash, initCash: cash, realized: 0, fees: 0, funding: 0, liquidations: 0,
    positions: {},   // coin -> { szi, entryPx, openedAt, fundingAt }（szi は符号付き。fundingAt = 最後に精算した funding 時刻）
    fundings: [],    // 新しい順。{ t, coin, szi, px, rate, amt }（amt は口座への増減、正=受取）
    orders: [],      // { oid, coin, side: "B"|"A", px, sz, ro, t }
    fills: [],       // 新しい順。{ t, coin, side, sz, px, fee, realized, kind: "market"|"limit"|"liq" }
    lev: {},         // coin -> leverage（未設定は PAPER_DEFAULT_LEV）
    nextOid: 1,
    createdAt: Date.now(),
  };
}

function paperLoad() {
  try {
    const a = JSON.parse(localStorage.getItem(PAPER_KEY));
    if (a && a.v === 1) return a;
  } catch { /* 壊れた JSON は作り直す */ }
  const a = paperNew();
  paperSave(a);
  return a;
}

function paperSave(a) {
  safeSet(PAPER_KEY, JSON.stringify(a));
  if (CLOUD) { paper.dirty = true; paperCloudSync(); }
}

// ---------- クラウド同期（CLOUD のみ） ----------
// 方式: localStorage = キャッシュ、サーバー = 正本。保存のたびに PUT（rev 付き楽観ロック）、
// 5 秒ティックでは If-None-Match 付き GET（変化なしは 304）で別端末の更新を取り込む。
// 409（rev 不一致 = 別端末が先に書いた）ならサーバー版を採用して再描画し、ローカルの変更は捨てる
// （同一ブラウザの 2 ペインは localStorage と rev を共有するので衝突しない）

const paperRev = () => Number(localStorage.getItem(PAPER_REV_KEY)) || 0;

function paperAdopt(d) {
  if (d.acct) safeSet(PAPER_KEY, JSON.stringify(d.acct));
  safeSet(PAPER_REV_KEY, String(d.rev));
}

async function paperApi(method, body, headers = {}) {
  const r = await fetch(`${CLOUD.api}/paper/${NET.isMainnet ? "mainnet" : "testnet"}`, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 401) { window.top.location.href = "/login"; throw new Error("unauthorized"); }
  return r;
}

// 起動時: サーバーの口座を読む（無ければローカル or 新規口座を初期登録）。成功するまで再試行
async function paperCloudLoad() {
  for (let delay = 2000; ; delay = Math.min(delay * 2, 30000)) {
    try {
      const r = await paperApi("GET");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.acct) {
        paperAdopt(d);
      } else {
        // サーバーが空（初回）: ローカルにあればそれを、無ければ新規口座を登録
        let a = null;
        try { a = JSON.parse(localStorage.getItem(PAPER_KEY)); } catch { /* 無視 */ }
        if (!a || a.v !== 1) a = paperNew();
        const p = await paperApi("PUT", { rev: d.rev, acct: a, force: true });
        if (!p.ok) throw new Error(`HTTP ${p.status}`);
        paperAdopt({ rev: (await p.json()).rev, acct: a });
      }
      paper.cloudReady = true;
      paper.dirty = false;
      if (typeof renderTradePane === "function") renderTradePane(); // ゲートを開く
      if (ACCT_ON) paperRender(paperLoad());
      return;
    } catch (e) {
      console.warn("paper cloud load:", e);
      paperNotify(T("クラウド口座の読込に失敗 — 再試行中…", "Failed to load cloud account — retrying…"), "err");
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// dirty なら PUT、そうでなければ GET（他端末の更新確認）。同時実行はしない（直列化）
function paperCloudSync() {
  if (!CLOUD || !paper.cloudReady) return paper.syncing;
  if (paper.syncing) return paper.syncing;
  paper.syncing = (async () => {
    try {
      if (paper.dirty) {
        let a = null;
        try { a = JSON.parse(localStorage.getItem(PAPER_KEY)); } catch { /* 無視 */ }
        if (!a) return;
        paper.dirty = false;
        const r = await paperApi("PUT", { rev: paperRev(), acct: a });
        if (r.status === 409) {
          paperAdopt(await r.json());
          paperNotify(T("[Paper] 別端末の更新が先に保存されていたため、サーバーの口座を取り込みました", "[Paper] Another device saved first — reloaded the account from the server"), "err");
          if (ACCT_ON) paperRender(paperLoad());
        } else if (r.ok) {
          safeSet(PAPER_REV_KEY, String((await r.json()).rev));
        } else {
          paper.dirty = true; // 次のティックで再送
          throw new Error(`HTTP ${r.status}`);
        }
      } else {
        const r = await paperApi("GET", undefined, { "If-None-Match": String(paperRev()) });
        if (r.status === 304) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.acct && d.rev !== paperRev() && !paper.dirty) {
          paperAdopt(d);
          if (ACCT_ON) paperRender(paperLoad());
        }
      }
    } catch (e) {
      console.warn("paper cloud sync:", e);
    } finally {
      paper.syncing = null;
      if (paper.dirty) paperCloudSync(); // 同期中に新しい保存があれば続けて送る
    }
  })();
  return paper.syncing;
}

// 評価用 mark。表示中の銘柄は WS の mark（最頻）、それ以外は allMids の mid
function paperMark(coin) {
  if (coin === state.coin && state.markPx > 0) return state.markPx;
  return Number(paper.mids[coin]) || 0;
}

async function paperLoadMids(force) {
  if (!force && Date.now() - paper.midsTs < PAPER_MIDS_STALE_MS) return;
  try {
    paper.mids = await info({ type: "allMids" });
    paper.midsTs = Date.now();
  } catch (e) { console.warn("paper allMids:", e); } // 前回値で継続
}

function paperLev(a, coin) {
  return a.lev[coin] ?? Math.min(PAPER_DEFAULT_LEV, state.maxLev[coin] || PAPER_DEFAULT_LEV);
}

// 口座の集計。mark 不明の銘柄は建値評価（含み損益 0）
function paperSummary(a) {
  let upnl = 0, marginUsed = 0, maint = 0;
  for (const [coin, p] of Object.entries(a.positions)) {
    const mark = paperMark(coin) || p.entryPx;
    const ntl = Math.abs(p.szi) * mark;
    upnl += (mark - p.entryPx) * p.szi;
    marginUsed += ntl / paperLev(a, coin);
    maint += ntl / (2 * (state.maxLev[coin] || PAPER_DEFAULT_LEV));
  }
  let reserved = 0;
  for (const o of a.orders) if (!o.ro) reserved += (o.sz * o.px) / paperLev(a, o.coin);
  const equity = a.cash + upnl;
  return { upnl, marginUsed, maint, reserved, equity, free: equity - marginUsed - reserved };
}

// 約定をポジションへ反映（ネッティング・平均建値・実現損益・手数料）
function paperApplyFill(a, { coin, isBuy, sz, px, taker, kind }) {
  const szd = state.szDecimals[coin] ?? 4;
  const rnd = (x) => Number(x.toFixed(szd));
  const fee = sz * px * (taker ? PAPER_TAKER_FEE : PAPER_MAKER_FEE);
  const p = a.positions[coin];
  const old = p ? p.szi : 0;
  const d = isBuy ? sz : -sz;
  let realized = 0;
  if (old === 0 || (old > 0) === (d > 0)) {
    // 新規 or 積み増し: 建値は数量加重平均
    const nsz = rnd(old + d);
    const entry = p ? (Math.abs(old) * p.entryPx + sz * px) / Math.abs(nsz) : px;
    a.positions[coin] = { szi: nsz, entryPx: entry, openedAt: p?.openedAt ?? Date.now(), fundingAt: p?.fundingAt ?? Date.now() };
  } else {
    // 反対売買: 既存分は実現、超過分はドテン（建値 = 約定価格）
    const closeSz = Math.min(Math.abs(old), sz);
    realized = (px - p.entryPx) * closeSz * (old > 0 ? 1 : -1);
    const rem = rnd(old + d);
    if (rem === 0) delete a.positions[coin];
    else if ((rem > 0) === (old > 0)) p.szi = rem;
    else a.positions[coin] = { szi: rem, entryPx: px, openedAt: Date.now(), fundingAt: Date.now() };
  }
  a.cash += realized - fee;
  a.realized += realized;
  a.fees += fee;
  a.fills.unshift({ t: Date.now(), coin, side: isBuy ? "B" : "A", sz, px, fee, realized, kind });
  if (a.fills.length > PAPER_MAX_FILLS) a.fills.length = PAPER_MAX_FILLS;
  return { realized, fee };
}

// funding の精算。各建玉について fundingAt より後の毎時精算（/info fundingHistory の実値）を順に
// 口座へ反映する。履歴が未反映（API ラグ）なら次回に持ち越し、問い合わせは銘柄ごと 1 分に 1 回。
// 価格は直近 2 分以内の精算なら現在 mark、それ以前（オフライン中の追い付き）はその時刻の 1h 足終値。
// 返り値 = 口座を変更したか
async function paperSettleFunding(a) {
  const now = Date.now();
  let changed = false;
  for (const [coin, p] of Object.entries(a.positions)) {
    if (p.fundingAt == null) { p.fundingAt = p.openedAt ?? now; changed = true; }
    const nextHour = (Math.floor(p.fundingAt / 3600000) + 1) * 3600000;
    if (nextHour > now) continue;                                   // まだ精算時刻が来ていない
    if (now - (paper.fundingChk[coin] || 0) < PAPER_FUNDING_RETRY_MS) continue;
    paper.fundingChk[coin] = now;
    let hist;
    try {
      hist = await info({ type: "fundingHistory", coin, startTime: p.fundingAt + 1 });
    } catch (e) { console.warn("paper fundingHistory:", e); continue; }
    if (!Array.isArray(hist)) continue;
    const due = hist.filter((h) => h.time > p.fundingAt && h.time <= now).sort((x, y) => x.time - y.time);
    if (!due.length) continue;
    // 価格: 追い付き分は 1h 足の終値（精算時刻 = 足の終了時刻）、直近は mark
    let closes = null;
    if (due.some((h) => now - h.time > 120000)) {
      try {
        const cs = await info({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: due[0].time - 7200000, endTime: now } });
        closes = new Map(cs.map((c) => [Number(c.T ?? (c.t + 3600000)), Number(c.c)]));
      } catch (e) { console.warn("paper funding candles:", e); }
    }
    const mark = paperMark(coin) || p.entryPx;
    for (const h of due) {
      const rate = Number(h.fundingRate);
      // 1h 足の T は終了時刻（ミリ秒、精算時刻の直前）。±1 分以内で最も近い足を探す
      let px = null;
      if (closes) {
        let best = Infinity;
        for (const [T, c] of closes) { const d = Math.abs(T - h.time); if (d < best && d <= 60000) { best = d; px = c; } }
      }
      if (!(px > 0)) px = mark;
      const amt = -p.szi * px * rate;   // 正の率 = Long が払う
      a.cash += amt;
      a.funding = (a.funding || 0) + amt;
      p.fundingAt = h.time;
      (a.fundings ||= []).unshift({ t: h.time, coin, szi: p.szi, px, rate, amt });
      changed = true;
    }
    if (a.fundings.length > PAPER_MAX_FUNDINGS) a.fundings.length = PAPER_MAX_FUNDINGS;
  }
  return changed;
}

// 発注（trade.js の検証後に呼ばれる）。返り値 { filled: {sz, px} } | { resting: {oid} }
// type: "market"|"limit"。market では px は無視（mark で約定）
async function paperPlace({ coin, isBuy, sz, px, type, ro }) {
  await paperLoadMids();
  const a = paperLoad();
  const mark = paperMark(coin);
  if (!(mark > 0)) throw new Error(T("mark 価格が未取得です", "Mark price unavailable"));
  const pos = a.positions[coin]?.szi ?? 0;
  if (ro) {
    // Reduce Only: 反対方向かつ既存サイズ以内に切り詰め（HL と同じ）
    if (pos === 0 || (pos > 0) === isBuy) throw new Error(T("Reduce Only: 減らすポジションがありません", "Reduce only: no position to reduce"));
    sz = Math.min(sz, Math.abs(pos));
  }
  const crossing = type === "market" || (isBuy ? mark <= px : mark >= px);
  // 証拠金チェック: ポジションを減らす分は不要、増やす（ドテン超過を含む）分だけ必要
  const reducing = pos !== 0 && (pos > 0) !== isBuy ? Math.min(Math.abs(pos), sz) : 0;
  const need = ((sz - reducing) * (crossing ? mark : px)) / paperLev(a, coin);
  const s = paperSummary(a);
  if (need > s.free + 1e-9) {
    throw new Error(T(`証拠金不足: 必要 ${fmtUsd2(need)} / 余力 ${fmtUsd2(s.free)}`, `Insufficient margin: need ${fmtUsd2(need)} / free ${fmtUsd2(s.free)}`));
  }
  if (crossing) {
    const r = paperApplyFill(a, { coin, isBuy, sz, px: mark, taker: true, kind: type === "market" ? "market" : "limit" });
    paperSave(a);
    return { filled: { sz, px: mark, ...r } };
  }
  const o = { oid: a.nextOid++, coin, side: isBuy ? "B" : "A", px, sz, ro: !!ro, t: Date.now() };
  a.orders.push(o);
  paperSave(a);
  return { resting: { oid: o.oid } };
}

function paperCancel(oid) {
  const a = paperLoad();
  const i = a.orders.findIndex((o) => o.oid === oid);
  if (i < 0) throw new Error(T("注文が見つかりません（約定済みの可能性）", "Order not found (it may have filled)"));
  a.orders.splice(i, 1);
  paperSave(a);
}

// 価格・数量の変更 = 取消して再発注（交差すれば即時約定。HL の modify も同じ挙動）。
// 再発注が証拠金不足等で失敗したら元の注文を戻す
async function paperModify(oid, px, sz) {
  const a = paperLoad();
  const i = a.orders.findIndex((o) => o.oid === oid);
  if (i < 0) throw new Error(T("注文が見つかりません（約定済みの可能性）", "Order not found (it may have filled)"));
  const [o] = a.orders.splice(i, 1);
  paperSave(a);
  try {
    return await paperPlace({ coin: o.coin, isBuy: o.side === "B", sz, px, type: "limit", ro: o.ro });
  } catch (e) {
    const b = paperLoad();
    b.orders.push(o);
    paperSave(b);
    throw e;
  }
}

function paperSetLeverage(coin, lev) {
  const a = paperLoad();
  const prev = a.lev[coin];
  a.lev[coin] = lev;
  const s = paperSummary(a);
  if (s.free < -1e-9) {
    if (prev == null) delete a.lev[coin]; else a.lev[coin] = prev;
    throw new Error(T(`レバレッジ ${lev}x では証拠金が不足します（余力 ${fmtUsd2(s.free)}）`, `Insufficient margin at ${lev}x (free ${fmtUsd2(s.free)})`));
  }
  paperSave(a);
}

// 5 秒ティック（供給役ペインのみ。app.js の refreshAccount から呼ばれる）:
// mids 更新 → 指値の約定判定 → 清算判定 → 描画
async function paperRefresh(force) {
  if (CLOUD) {
    if (!paper.cloudReady) return; // 初期ロード待ち（paperCloudLoad が完了時に描画する）
    await paperCloudSync();        // 別端末の更新を取り込んでから約定判定する
  }
  await paperLoadMids(force === true || Date.now() - paper.midsTs > 4000);
  const a = paperLoad();
  let changed = await paperSettleFunding(a); // funding で口座価値が減れば下の清算判定に効く
  for (const o of a.orders.slice()) {
    const mark = paperMark(o.coin);
    if (!(mark > 0)) continue;
    const isBuy = o.side === "B";
    if (!(isBuy ? mark <= o.px : mark >= o.px)) continue;
    let sz = o.sz;
    if (o.ro) {
      // Reduce Only は約定時点のポジションに合わせて切り詰め。減らす対象が無ければ取消
      const pos = a.positions[o.coin]?.szi ?? 0;
      if (pos === 0 || (pos > 0) === isBuy) { a.orders.splice(a.orders.indexOf(o), 1); changed = true; continue; }
      sz = Math.min(sz, Math.abs(pos));
    }
    paperApplyFill(a, { coin: o.coin, isBuy, sz, px: o.px, taker: false, kind: "limit" });
    a.orders.splice(a.orders.indexOf(o), 1);
    changed = true;
    paperNotify(T(`[Paper] 指値約定: ${o.coin} ${isBuy ? "買い" : "売り"} ${sz} @ ${fmtAnyPx(o.px)}`,
      `[Paper] Limit filled: ${o.coin} ${isBuy ? "buy" : "sell"} ${sz} @ ${fmtAnyPx(o.px)}`), "ok");
  }
  const s = paperSummary(a);
  if (Object.keys(a.positions).length && s.equity < s.maint) {
    for (const [coin, p] of Object.entries(a.positions)) {
      paperApplyFill(a, { coin, isBuy: p.szi < 0, sz: Math.abs(p.szi), px: paperMark(coin) || p.entryPx, taker: true, kind: "liq" });
    }
    a.orders = [];
    a.liquidations++;
    if (a.cash < 0) a.cash = 0;
    changed = true;
    paperNotify(T("[Paper] 清算されました — 全ポジションを強制クローズし注文を取消しました", "[Paper] Liquidated — all positions force-closed, orders cancelled"), "err");
  }
  if (changed) paperSave(a);
  paperRender(a);
}

function paperNotify(msg, cls) {
  if (typeof tradeStatus === "function") tradeStatus(msg, cls);
}

// clearinghouseState / frontendOpenOrders 相当のオブジェクトを組み、app.js の renderAccount に流す
function paperRender(a) {
  const s = paperSummary(a);
  const assetPositions = Object.entries(a.positions).map(([coin, p]) => {
    const mark = paperMark(coin) || p.entryPx;
    const ntl = Math.abs(p.szi) * mark;
    const lev = paperLev(a, coin);
    const upnl = (mark - p.entryPx) * p.szi;
    // 清算価格の近似: 他銘柄の mark と維持証拠金を現在値で固定し、口座価値が維持証拠金合計まで減る mark
    const room = s.equity - s.maint;
    const liq = p.szi > 0 ? mark - room / Math.abs(p.szi) : mark + room / Math.abs(p.szi);
    return { position: {
      coin, szi: String(p.szi), entryPx: String(p.entryPx), positionValue: String(ntl),
      unrealizedPnl: String(upnl),
      returnOnEquity: String((upnl * lev) / (Math.abs(p.szi) * p.entryPx)),
      liquidationPx: liq > 0 ? String(liq) : null,
      marginUsed: String(ntl / lev),
      leverage: { type: "cross", value: lev },
    } };
  });
  const ch = {
    assetPositions,
    marginSummary: { accountValue: String(s.equity), totalMarginUsed: String(s.marginUsed) },
    withdrawable: String(Math.max(0, s.free)),
  };
  const orders = a.orders.map((o) => ({
    oid: o.oid, coin: o.coin, side: o.side, limitPx: String(o.px), sz: String(o.sz), timestamp: o.t,
    reduceOnly: o.ro, tif: "Gtc", orderType: "Limit", isTrigger: false,
  }));
  state.openOrders = orders; // modifyOrder の参照元（実口座では refreshAccount が設定している）
  renderAccount(ch, orders, { usdcAvail: 0, tokensVal: 0, total: 0 }, 0, 0, null, 0);

  // paper 固有の上書き: 総資産 tooltip・入出金ボタン → リセット・約定履歴
  const sign = (x) => (x >= 0 ? "+" : "") + fmtUsd2(x);
  acct("ac-equity").title = T(
    `ペーパー口座。初期資金 ${fmtUsd2(a.initCash)} / 実現損益 ${sign(a.realized)} / 手数料 −${fmtUsd2(a.fees)} / 資金調達料 ${sign(a.funding || 0)} / 含み損益 ${sign(s.upnl)} / 清算 ${a.liquidations} 回`,
    `Paper account. Initial ${fmtUsd2(a.initCash)} / realized ${sign(a.realized)} / fees −${fmtUsd2(a.fees)} / funding ${sign(a.funding || 0)} / unrealized ${sign(s.upnl)} / liquidations ${a.liquidations}`);
  acct("ac-avail").title = T(`余力 = 残高 ${fmtUsd2(a.cash)} + 含み損益 ${sign(s.upnl)} − 使用証拠金 ${fmtUsd2(s.marginUsed)}（指値の予約 ${fmtUsd2(s.reserved)} は発注時に別途差引）`,
    `Free = cash ${fmtUsd2(a.cash)} + unrealized ${sign(s.upnl)} − margin used ${fmtUsd2(s.marginUsed)} (resting-order reserve ${fmtUsd2(s.reserved)} is deducted at order time)`);
  const xfer = acct("acct-xfer");
  if (xfer) xfer.hidden = true;
  const pp = acct("acct-paper");
  if (pp) pp.hidden = false;
  const pnl = acct("paper-pnl");
  if (pnl) {
    const total = s.equity - a.initCash;
    pnl.textContent = T(`累計 ${sign(total)}`, `Total ${sign(total)}`);
    pnl.className = signCls(total);
  }
  const tb = acct("paper-fills")?.tBodies[0];
  if (tb) {
    // 約定と funding 精算を時刻順に混ぜて表示（保存は別配列なので funding が約定履歴を押し出さない）
    const rows = a.fills.concat((a.fundings || []).map((f) => ({ ...f, kind: "funding" })))
      .sort((x, y) => y.t - x.t).slice(0, 60);
    tb.innerHTML = rows.length
      ? rows.map((f) => {
          const time = new Date(f.t).toLocaleString("ja-JP", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          if (f.kind === "funding") {
            const rateTxt = `${(f.rate * 100).toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}%/h`;
            return `<tr class="funding" title="${T(`資金調達料 ${rateTxt} × 建玉 ${fmtNum(f.szi, state.szDecimals[f.coin] ?? 4)} × ${fmtAnyPx(f.px)}`, `Funding ${rateTxt} × position ${fmtNum(f.szi, state.szDecimals[f.coin] ?? 4)} × ${fmtAnyPx(f.px)}`)}">
            <td>${time}</td>
            <td class="coin">${esc(f.coin)}</td>
            <td><span class="tag">${T("資金調達", "Funding")}</span> ${rateTxt}</td>
            <td class="${signCls(f.szi)}">${fmtNum(f.szi, state.szDecimals[f.coin] ?? 4)}</td>
            <td>${fmtAnyPx(f.px)}</td>
            <td>–</td>
            <td class="${signCls(f.amt)}">${fmtUsd2(f.amt)}</td>
          </tr>`;
          }
          const tag = f.kind === "liq" ? ' <span class="tag">LIQ</span>' : f.kind === "limit" ? ' <span class="tag">LMT</span>' : "";
          return `<tr>
            <td>${time}</td>
            <td class="coin">${esc(f.coin)}</td>
            <td class="${f.side === "B" ? "buy" : "sell"}">${f.side === "B" ? "Buy" : "Sell"}${tag}</td>
            <td>${fmtNum(f.sz, state.szDecimals[f.coin] ?? 4)}</td>
            <td>${fmtAnyPx(f.px)}</td>
            <td>${fmtUsd2(f.fee)}</td>
            <td class="${signCls(f.realized)}">${f.realized ? fmtUsd2(f.realized) : "–"}</td>
          </tr>`;
        }).join("")
      : `<tr><td class="empty" colspan="7">${T("約定なし", "No fills")}</td></tr>`;
  }
}

// 口座リセット（初期資金を入力）。共有 footer のボタンから供給役ペインが処理する
async function paperReset() {
  const a = paperLoad();
  const s = paperSummary(a);
  const amtIn = await xferDialog({
    title: T("ペーパー口座のリセット", "Reset paper account"),
    html: T(`ポジション・注文・約定履歴を消去し、残高を初期化します。<br>現在: 口座価値 <b>${fmtUsd2(s.equity)}</b>（初期 ${fmtUsd2(a.initCash)}）<br>新しい初期資金 (USDC):`,
      `Clears positions, orders and fill history and resets the balance.<br>Now: equity <b>${fmtUsd2(s.equity)}</b> (initial ${fmtUsd2(a.initCash)})<br>New initial balance (USDC):`),
    input: String(a.initCash),
    okLabel: T("リセット", "Reset"),
  });
  if (amtIn === null) return;
  try {
    const cash = Math.round(parsePositive(amtIn, T("初期資金", "initial balance")) * 100) / 100;
    paperSave(paperNew(cash));
    paperNotify(T(`[Paper] 口座をリセットしました（${fmtUsd2(cash)}）`, `[Paper] Account reset (${fmtUsd2(cash)})`), "ok");
    refreshAccount();
  } catch (e) {
    paperNotify(errMsg(e), "err");
    alert(T("リセットに失敗:\n", "Reset failed:\n") + errMsg(e));
  }
}

// 起動時（app.js の boot、銘柄メタ取得後）。アカウント欄を常時表示してティックを開始
function paperStart() {
  if (CLOUD) paperCloudLoad(); // 両ペインとも: サーバーの口座をキャッシュへ（完了までゲート表示）
  // 未接続でも発注できるので、レバレッジ行は接続イベント待ちでなくここで初期化する（両ペイン）
  if (typeof refreshLeverage === "function") refreshLeverage();
  if (!ACCT_ON) return;
  const el = acct("account");
  el.hidden = false;
  el.classList.add("paper");
  const sec = acct("paper-fills-sec");
  if (sec) sec.hidden = false;
  const rst = acct("paper-reset");
  if (rst) rst.onclick = paperReset; // ペイン reload でリスナーが積み重ならないよう onclick 代入
  refreshAccount();
  state.acctTimer = setInterval(refreshAccount, 5000);
}
