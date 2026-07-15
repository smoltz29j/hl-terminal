# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Hyperliquid の独自フロントエンド「HL Terminal」。リアルタイム相場ビューア（ローソク足・MA/BB 指標・板・約定・ステータス）+ ウォレット接続によるアカウント表示（資産・ポジション・注文）+ **発注機能**（API ウォレット方式・指値/成行/キャンセル）。ビルド不要の静的ファイル構成（vanilla JS + lightweight-charts v4 / ethers v6 CDN）で、バックエンドは持たず、ブラウザから Hyperliquid の API を直接叩く。接続先は設定で公式 Mainnet / Testnet / カスタム（サードパーティ API サーバー）に切替可能。

## 実行

```
./run.sh [port]   # デフォルト 8010。python3 http.server で 0.0.0.0 に配信
```

elwhite (192.168.101.201) 上で動かし、LAN のブラウザから `http://192.168.101.201:8010/` で開く想定。ビルド・テスト・lint は無し。ufw は 8010/tcp を 192.168.101.0/24 に対して許可済み（2026-07-11）。

本番は systemd ユーザーユニット `hl-terminal.service`（`~/.config/systemd/user/`、Restart=always・linger 有効）で常駐。再起動は `systemctl --user restart hl-terminal`。run.sh は手元試験用。実需フィードの `btc-demand.service`（port 8765、crypto_analysis）も同様にユニット化済み。

## アーキテクチャ

- フロントは `index.html` / `style.css` / `app.js`（相場・アカウント・設定）/ `hl-sign.js`（署名）/ `trade.js`（発注 UI）+ `metamask-sdk.bundle.js`（後述のビルド成果物）。全て classic script で、app.js のトップレベル変数（`state`・`NET` 等）を後続の trade.js が直接参照する（読み込み順を変えないこと）。
- ウォレット接続は **MetaMask SDK**（`@metamask/sdk` 0.34.0）。拡張があればそれを使い、無ければ SDK 純正モーダルが QR を表示 → スマホの MetaMask アプリでスキャン・承認すると本セッションが張られる（app.hyperliquid.xyz と同じ UX。通信は MetaMask のリレーサーバー経由なので LAN http でも動く）。セッションは localStorage に永続化され、2回目以降は QR なしで再接続。切断は `mmsdk.terminate()`。WalletConnect は projectId 登録が必要なため不採用。自前 QR ペアリング方式（pair.html + server.py API）も過去に実装したが「アドレスを渡すだけで本接続ではない」ため撤去済み。
- `metamask-sdk.bundle.js` は `./build-sdk.sh` で生成する（npm の UMD ビルドが依存を外部グローバルに期待していて単体で動かないため、esbuild で自己完結バンドルしている）。**MetaMask SDK は ConsenSys 独自ライセンスで再配布不可のため、バンドルは .gitignore 済み・リポジトリに含めないこと。**
- データ源は2系統（キー不要・CORS 許可済み）:
  - REST `POST /info` — 初期データ。`metaAndAssetCtxs`（銘柄一覧+出来高ソート。**元 index が発注用 asset id** → `state.assetIds`）、`candleSnapshot`（ローソク足の初期300本）。さらに**板は REST `l2Book` を1秒ポーリング**（`BOOK_POLL_MS`。WS の l2Book snapshot は全公式エンドポイントで約5秒間隔しか来ないため — 2026-07-15 実測、nSigFigs 指定でも不変。タブ非表示中は停止、WS 側と renderBook の `state.bookTime` ガードで整合）。
  - WebSocket `wss://…/ws` — リアルタイム。`l2Book` / `trades` / `candle` / `activeAssetCtx` を購読。銘柄・足切替時は unsubscribe→REST 再取得→subscribe（`switchTo()`）。45秒毎に ping、切断時は指数バックオフで再接続。
- **サブティッカー（#ticker）**: HIP-3 xyz DEX 銘柄の mark/24h% を常時表示（現構成: WTIOIL=`xyz:CL`・GOLD・Nasdaq100=`xyz:XYZ100`・MU・SPCX。表示名は info `perpConciseAnnotations` の displayName ベースだが Nasdaq100 はユーザー指定の呼称。API 名と別なので注意）。初期値は REST `metaAndAssetCtxs`+`dex:"xyz"`、以後は WS `activeAssetCtx` の常時購読（`switchTo()` の unsubscribe 対象外 — ただしティッカー無効ペインでは通常購読に戻す `TICKER_ON` 分岐あり）。xyz DEX の無い接続先（testnet 等）では自動非表示。銘柄は app.js の `TICKER_COINS`。1画面では topbar 直下、2画面では duo.html 最上段（左ペインが `window.top.document` の #ticker へ描画）。
- **銘柄セレクタ**: 検索欄（#coin-filter）+ ネイティブ `<select>` の併用。入力でプルダウンの option を絞り込み（前方一致優先、部分一致は銘柄名のみ）、Enter で先頭候補に切替。既定 DEX に加え **HIP-3 builder DEX 全銘柄**（perpDexs 列挙 → dex 別 metaAndAssetCtxs）を出来高順で統合し、表示名は displayName+"(dex)"。**builder DEX 銘柄は `state.assetIds` に未登録 = 発注・レバレッジ変更は意図的にブロック**（asset id が別採番 100000+dexIndex*10000+i で実サーバー未検証のため。有効化するなら /exchange のエラー応答の復元アドレス法で検証してから）。
- **2画面モード（duo.html）**: PC（>900px）は既定で duo.html へリダイレクト（index.html 冒頭のインラインスクリプト。「1画面」選択で localStorage `hlt-view`=single）。duo.html は index.html?pane=1/2 を iframe で左右に並べるだけで、各ペインは WS・チャート・発注まで完全独立。共有要素: ウォレット接続（setUser のペイン間ブロードキャスト）・最上段ティッカー・API 設定（storage イベントで他ペイン追従 reload）。ペイン内は `html.framed` で幅に依らずデスクトップ型レイアウト（右カラム 260px）。銘柄はペイン別に `hlt-coin:pN` へ記憶。急落警報の音/通知は pane=2 を消音。
- **API 接続先切替**: localStorage `hlt-api`（⚙ボタンの設定モーダル）。公式 Mainnet / 公式 Testnet / **プリセット代替 `api-ui.hyperliquid.xyz`・`api2.hyperliquid.xyz`**（公式運営の別レートリミットプール。REST+CORS+WS 動作確認 2026-07-14）/ カスタム URL（Chainstack 等キー付きサードパーティ用。mainnet/testnet フラグ付き — 署名の `hyperliquidChain` と phantom agent の source 判定に使う）。切替は `location.reload()` で全状態を作り直す。非デフォルト時は topbar に TESTNET/API-UI/API2/CUSTOM バッジ表示。
- **チャート指標**: MA(20)=黄 `#c98500`・MA(50)=青 `#3987e5`・BB(20,2σ)=マゼンタ `#d55181`（3色相互の CVD 分離を dataviz validator で検証済み）。`state.candles` から計算し、WS の candle 更新では最終点のみ `series.update()`。トグルは localStorage `hlt-ind`。
- **自動トレンドチャネル（TL トグル）**: 各区間に終値の回帰直線 ± 高値/安値へのオフセットの平行線を描画。上下限は片側4%のバーのはみ出しを許容する分位点（極端なヒゲで幅が水増しされない）。区間検出は3層構成:
  - **長期** = トップダウン分割。全期間を「チャネル幅 ≤ 平均価格の22%（`TL_COHERENT_FRAC`）で一貫」になるまで最良分割点（子チャネル幅の最大値が最小になる点を全候補走査）で再帰分割し、隣接リーフは一貫性を保つ限り再統合。**ピボットに依らないため数ヶ月のレンジ帯が一組の平行線にまとまる**（幅の相対比較ではレンジ統合と急落分離が両立できないことを実データで確認済み — 絶対基準が本質）。境界は後処理で2段階調整: ①±20本の範囲で「幅×長さ」合計が最小になる位置へ局所最適化（幅のみのコストは片側を極小化する退化があり不可）、②傾きが下向きに変わる境界は近傍±10本の局所高値へ・上向きは局所安値へスナップ（人間が境界を天井/大底に置く感覚。2026-01 の持ち合い上限 1/14 で実例検証済み）、③境界調整で一貫性を失った区間は再分割してから最終統合（例: 2026-01 は「天井→踊り場→滝」の構造で、踊り場は持ち合い側に統合され 1/28→2/6 の滝が独立チャネルになる — ユーザー指定の区切りと一致することを検証済み）。
  - **短期/中期** = スイングピボット（±2/±4本の最値）の H/L 交互列で HH/HL・LH/LL の反転点から区間化し、最良分割点での再帰分割（子幅が75%未満に縮む場合のみ）で急落ともみ合いの融合を分離。
  - **直近レッグ** = 反転未確定でも直近30本の最安値/最高値→現在を常時候補化。
  選抜は長期優先で「ほぼ同一区間」を重複除去した後、**短期/中期チャネルは「右端に届く現況チャネル」か「直近90本以内の急変（重なる長期バンドを12本未満で横断する傾き差）」だけ残す**（大トレンド把握のテーゼに合わせたホワイトリスト方式。過去の細かいレッグ・長期内を漂う中間チャネルは描かない。幅比だけでは急落と冗長チャネルを区別できないことを実測済み — 発散速度が本質的な識別子）。最大16本。確定区間は検証用に `state.tlSegs` に残る。
- **チャネル×BB 交差シグナル**: BB 下バンドがチャネル下線を下抜けた足に ▼（売り色）、BB 上バンドがチャネル上線を上抜けた足に ▲（買い色）のマーカーを `candleSeries.setMarkers` で表示。ユーザーの観察（2026-06 月初: 緩上昇チャネル下線×BB 下バンドの交差→本格急落）に基づく。評価は左右延長を含む「フィット確認済み範囲」全体（持ち合い天井の延長線への BB 突き抜け=過熱の検出に必要）。TL と BB の両トグルが ON のときだけ表示。
- **パターン監視バッジ（#tl-watch、日足のみ）**: ユーザーのテーゼ「2〜4ヶ月の緩い上昇/横ばいチャネル → 天井過熱(▲) → 床破断(▼) → 急落」（2026-02 と 2026-06 の2回で成立）を右端の live 長期チャネルに適用し、段階を凡例下のバッジで表示。監視中（灰）→ 天井過熱 = live チャネルの ▲ が15本以内（琥珀）→ 床破断 = ▼ が5本以内（赤・「過去2回はここから急落」）。判定対象は live チャネル自身のシグナルのみ（他チャネルの ▼ では発火しない）。**過去データを切り詰めた再現テストで、1月の滝の前日・6月急落の3日前に「床破断」、その前に「天井過熱」が出ることを検証済み**。緩さの条件: 傾きが幅を50本未満で割り込まず、25本未満で突き抜けない。ただしテクニカル単独では 2026-04-01 のように実需の買いに覆される（▼が騙しになる）ことがある。
- **総合急落警報（#crash-alert）**: 局面（SMA200）× パターン段階 × 実需フローの合議。レベル3 = 弱気局面で床破断かつ現物買い支えなし（バックテストの 30日内 -18% 超 32% 構成）→ 赤点滅バナー + ブラウザ通知 + ビープ（localStorage `hlt-alerted` に日付×レベルで重複抑止 — 再読込では鳴らさない）。レベル2 = 破断だが現物買い（騙し注意）/ 弱気局面の天井過熱 → 琥珀バナー。レベル2以上はタブタイトルに ⚠/🚨 前置。判定は `updateCrashAlert()`（applyTlWatch 経由で30秒毎更新）。
- **実需フィード連携（任意）**: 同一ホスト port 8765 の `~/claude/crypto_analysis/realtime_demand` サーバー（aiohttp、spot/perp テイカーフロー配信）に WS 接続し、直近5分の現物（Binance+Coinbase spot）/perp のフロー方向をバッジ末尾に追記（判定閾値は realtime_demand の classify と同一）。床破断時は「現物買い=騙しの可能性 / 現物売り=信頼度高」を注記。サーバー未起動なら指数バックオフで静かに退きテクニカルのみ表示。localStorage `hlt-demand` で URL 上書き・`off` で無効化。LAN から使うにはサーバーを `--host 0.0.0.0` で起動しておくこと。検出区間の外側へは「バーがチャネル内（幅の20%まで許容）に収まる限り」自身の区間長を上限に左右へ延長し、右端まで届いたチャネルは未来へ8本延長。ただし未来延長は緩やかなチャネルのみ（延長で線が動く量がチャネル幅の35%を超える急勾配は、右端の空間に浮いた短い急斜線になるだけなので延長しない — ユーザーから「バグでは」と指摘された経緯あり）。**本体 = 黄 `#d0bd2b`・延長部分 = teal `#2aa3ba`** の破線で色分け（両色とも既存5色および相互の CVD 分離を dataviz validator で検証済み。黄の明度は系列色の推奨帯より上だが注釈線として意図的）。`autoscaleInfoProvider: () => null` で縦スケールに影響させない。再計算は初期ロードと新バー確定時のみ。デフォルト足は 1d（トレンド把握用）。
- **発注（trade.js + hl-sign.js）**: API ウォレット方式。
  - 有効化 = `approveAgent`（user-signed EIP-712）を MetaMask の `eth_signTypedData_v4` で署名（`signatureChainId` はウォレットの現在チェーン）。agent 鍵はブラウザ内で生成し localStorage `hlt-agent:<net>:<user>` に保存（名前 "hlterm"）。メイン秘密鍵はブラウザに置かない。agent 鍵では出金不可。
  - 注文/修正/キャンセル = L1 action（order / batchModify / cancel）。修正は frontendOpenOrders（openOrders でなくこちらを使う理由 = tif/reduceOnly/isTrigger が取れる）の値を引き継ぎ、通常の Limit のみ対応。`msgpack(action) + nonce(8B BE) + 0x00(vault なし)` を keccak → phantom agent `{source: "a"(mainnet)/"b"(testnet), connectionId}` → EIP-712（domain: Exchange/1337）を agent 鍵（ethers.Wallet）で署名 → `POST /exchange`。**msgpack のキー順序がハッシュに影響するため、order wire は a,b,p,s,r,t、action は type,orders,grouping の順を崩さないこと。**
  - 成行 = IOC 指値（mark±5%、有効数字5桁 + 小数 6-szDecimals 桁に丸め）。価格・サイズは `floatToWire()` で文字列化（Python SDK の float_to_wire と同一規則）。
  - Mainnet では送信前に confirm ダイアログ。agent 失効（"does not exist" 系エラー）時は鍵を破棄して再有効化を促す。
  - **hl-sign.js は Python SDK (signing.py) とバイト互換であることを検証済み**（eth_account との r/s/v 一致 + testnet 実サーバーの復元アドレス一致）。変更したら同じ検証を再実行すること（未承認のランダム agent 鍵で /exchange に投げると、エラー文中にサーバーが署名から復元したアドレスが出るので突き合わせられる）。
- 接続は現状アドレス取得のみに使用（署名要求はしない）。アドレス手入力のウォッチモードあり。`?user=0x…` クエリでも起動可（puppeteer テストに便利）。アカウントデータは REST `clearinghouseState` + `openOrders` の5秒ポーリング（webData2 購読は応答が確認できなかったため不採用）。
- 価格の表示桁 `state.pxDecimals` は API が返す文字列の小数桁から動的に導出（銘柄ごとに桁が違うため）。サイズ桁は meta の `szDecimals`。
- lightweight-charts はエポックを UTC 表示するため、`TZ_SHIFT` でローカル時刻に見えるようずらしている。時刻を扱うときはこの補正を壊さないこと。

## 配色

買い `#0ca30c` / 売り `#e66767`（ダーク背景 `#1a1a19` に対し CVD 検証済み・deutan ΔE 23.4）。変更する場合は dataviz skill の validate_palette.js で再検証する。

## 未検証・今後

- スマホ MetaMask（QR セッション）経由の `eth_signTypedData_v4` 実機承認は未検証（署名データ形式は SDK 互換を確認済み）。
- testnet での実約定テストにはユーザーの testnet 入金が必要（faucet: app.hyperliquid-testnet.xyz、mainnet 残高のあるアドレスが条件）。
- TP/SL（trigger 注文）・cloid は未実装。レバレッジ変更（`updateLeverage`、Cross/Isolated 切替付き）は実装済み — 現在値は info `activeAssetData`、action のキー順は type,asset,isCross,leverage（署名バイト互換は復元アドレス法で検証済み 2026-07-14）。
- builder DEX 銘柄（xyz: 等）の発注・レバレッジ変更は asset id 未検証のため無効化中（上記セレクタ項参照）。
- **JS/CSS を変更したら index.html の `?v=` 4箇所 + duo.html の style.css?v= を上げること**（キャッシュバスター。iPhone Safari が古い JS を使い回す実害があった）。
