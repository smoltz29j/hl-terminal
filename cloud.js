// クラウド版の設定スクリプト。LAN 版（serve.py）ではこのファイルがそのまま配信され、
// HLT_CLOUD = null = 従来どおりの動作。takerflow 版では cloud/server.py が同じパスを
// 動的生成（{paperOnly:true, api:"/api", demand:"wss://…"}）して差し替える。
// → app.js の CLOUD 定数を参照。paper 固定・ウォレット無し・口座はサーバー保存になる
window.HLT_CLOUD = null;
