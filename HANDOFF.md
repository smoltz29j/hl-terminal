# HANDOFF

**このプロジェクトの詳細（設計判断・ハマりどころ・未検証事項）は `CLAUDE.md` が正**（46KB。ワークスペース共通ルールの「HANDOFF=詳細」とは逆なので注意）。未検証・未実装の一覧は CLAUDE.md「未検証・今後」節。発注系（hl-sign.js・trade.js）を触る前に必ず CLAUDE.md の該当節を読む。ここには変更履歴だけを置く。

# 変更履歴
- 2026-11-08 Weiss が適用: tools/crash_watch.mjs に crash_watch.log 5MB 超で .1 へ rename（1 世代）を追加、.gitignore に .1 追加。
- 2026-11-10 総点検（詳細: `~/claude/chief-of-staff/notes/総点検-20261110/B-hl-stock-vps.md`）:
  - `serve.py` をホワイトリスト配信に変更。それまで `https://192.168.101.201:8010/hl-paper-password.txt`（クラウド版の平文パスワード）や CLAUDE.md・tools/・cloud/server.py が LAN/VPN から無認証で取れた。**稼働中の hl-terminal.service は未再起動 = 露出は再起動まで続く**（`systemctl --user restart hl-terminal`）。再起動後にクラウド版パスワードの変更を推奨。
  - `cloud/server.py`: (1) ユーザー名に "." を含むとセッショントークンの分解に失敗し、ログインできても常に未認証になるバグを修正。(2) 口座 JSON の直前版退避を rename → copy に変更（本体が存在しない瞬間を無くす）。**VPS へは未デプロイ**（`./deploy_takerflow.sh` は T の判断で）。ローカルで tmp の HLT_DATA を使い確認済み。
  - `metamask-sdk.bundle.js` は `.sdk-build/node_modules`（lockfile: 154 パッケージ全て registry.npmjs.org・integrity 付き）から esbuild で再生成したものと sha256 一致（bde7612c…）を確認。
