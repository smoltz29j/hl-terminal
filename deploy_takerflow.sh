#!/usr/bin/env bash
# takerflow.com:8010（Vultr VPS, ssh vultr）へクラウド版（ペーパートレード専用）をデプロイする。
# 正本は ElWhite のこのディレクトリ。VPS 側は ~/apps/hl-paper/ に置き、systemd ユーザーユニット
# hl-paper（cloud/hl-paper.service）が 127.0.0.1:18010 で待受、Caddy が https://takerflow.com:8010 で TLS 終端。
#
# 送るのはクラウド版が配信するファイルだけ（ホワイトリスト）。MetaMask SDK バンドル（再配布不可）・
# certs/（秘密鍵）・tools/・.git は送らない。VPS 側の data/（パスワードハッシュ・口座 JSON）は触らない。
set -euo pipefail
cd "$(dirname "$0")"

rsync -av --delete \
  --include 'index.html' --include 'duo.html' --include 'style.css' --include 'cloud.js' \
  --include 'app.js' --include 'hl-sign.js' --include 'paper.js' --include 'trade.js' \
  --include 'cloud/' --include 'cloud/server.py' --include 'cloud/hl-paper.service' \
  --exclude 'cloud/data/' --exclude '*' \
  ./ vultr:apps/hl-paper/
ssh vultr 'mkdir -p ~/.config/systemd/user && cp ~/apps/hl-paper/cloud/hl-paper.service ~/.config/systemd/user/ \
  && systemctl --user daemon-reload && systemctl --user enable --now hl-paper >/dev/null \
  && systemctl --user restart hl-paper && sleep 3 && systemctl --user is-active hl-paper'

# 検証: 公開 URL の /healthz（無認証）が返す md5 がローカルと一致するか（ufw 未開放の間は VPS 内から Caddy 経由で確認）
local_md5=$(md5sum app.js | cut -d' ' -f1)
remote=""
for _ in $(seq 10); do
  remote=$(curl -s --max-time 5 https://takerflow.com:8010/healthz 2>/dev/null \
    || ssh vultr 'curl -s --max-time 5 --resolve takerflow.com:8010:127.0.0.1 https://takerflow.com:8010/healthz') || true
  [[ "$remote" == *"$local_md5"* ]] && break
  sleep 3
done
if [[ "$remote" == *"$local_md5"* ]]; then
  echo "OK: takerflow.com:8010 は最新 (app.js md5=$local_md5) — $remote"
else
  echo "NG: 配信中の app.js がローカルと不一致 (local=$local_md5 remote=$remote)" >&2
  exit 1
fi
