# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Hyperliquid の独自フロントエンド「HL Terminal」。読み取り専用のリアルタイム相場ビューア（ローソク足・板・約定・ステータス）+ ウォレット接続によるアカウント表示（資産・ポジション・注文）。署名・発注は未実装。ビルド不要の静的ファイル構成（vanilla JS + lightweight-charts v4 CDN）で、バックエンドは持たず、ブラウザから Hyperliquid の公開 API を直接叩く。

## 実行

```
./run.sh [port]   # デフォルト 8010。python3 http.server で 0.0.0.0 に配信
```

elwhite (192.168.101.201) 上で動かし、LAN のブラウザから `http://192.168.101.201:8010/` で開く想定。ビルド・テスト・lint は無し。ufw は 8010/tcp を 192.168.101.0/24 に対して許可済み（2026-07-11）。

## アーキテクチャ

- フロントは `index.html` / `style.css` / `app.js`（全ロジック）+ `metamask-sdk.bundle.js`（後述のビルド成果物）。
- ウォレット接続は **MetaMask SDK**（`@metamask/sdk` 0.34.0）。拡張があればそれを使い、無ければ SDK 純正モーダルが QR を表示 → スマホの MetaMask アプリでスキャン・承認すると本セッションが張られる（app.hyperliquid.xyz と同じ UX。通信は MetaMask のリレーサーバー経由なので LAN http でも動く）。セッションは localStorage に永続化され、2回目以降は QR なしで再接続。切断は `mmsdk.terminate()`。WalletConnect は projectId 登録が必要なため不採用。自前 QR ペアリング方式（pair.html + server.py API）も過去に実装したが「アドレスを渡すだけで本接続ではない」ため撤去済み。
- `metamask-sdk.bundle.js` は `./build-sdk.sh` で生成する（npm の UMD ビルドが依存を外部グローバルに期待していて単体で動かないため、esbuild で自己完結バンドルしている）。**MetaMask SDK は ConsenSys 独自ライセンスで再配布不可のため、バンドルは .gitignore 済み・リポジトリに含めないこと。**
- データ源は2系統（どちらも api.hyperliquid.xyz、キー不要・CORS 許可済み）:
  - REST `POST /info` — 初期データ。`metaAndAssetCtxs`（銘柄一覧+出来高ソート）、`candleSnapshot`（ローソク足の初期300本）。
  - WebSocket `wss://…/ws` — リアルタイム。`l2Book` / `trades` / `candle` / `activeAssetCtx` を購読。銘柄・足切替時は unsubscribe→REST 再取得→subscribe（`switchTo()`）。45秒毎に ping、切断時は指数バックオフで再接続。
- 接続は現状アドレス取得のみに使用（署名要求はしない）。アドレス手入力のウォッチモードあり。`?user=0x…` クエリでも起動可（puppeteer テストに便利）。アカウントデータは REST `clearinghouseState` + `openOrders` の5秒ポーリング（webData2 購読は応答が確認できなかったため不採用）。
- 価格の表示桁 `state.pxDecimals` は API が返す文字列の小数桁から動的に導出（銘柄ごとに桁が違うため）。サイズ桁は meta の `szDecimals`。
- lightweight-charts はエポックを UTC 表示するため、`TZ_SHIFT` でローカル時刻に見えるようずらしている。時刻を扱うときはこの補正を壊さないこと。

## 配色

買い `#0ca30c` / 売り `#e66767`（ダーク背景 `#1a1a19` に対し CVD 検証済み・deutan ΔE 23.4）。変更する場合は dataviz skill の validate_palette.js で再検証する。

## 今後の予定（未実装）

- 発注機能: ウォレット秘密鍵での EIP-712 署名が必要。`POST /exchange`。実装するならまず testnet (api.hyperliquid-testnet.xyz) で。
