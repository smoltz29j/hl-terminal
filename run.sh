#!/bin/bash
# HL Terminal を LAN 向けに配信する（静的ファイルのみ）。
# certs/ があれば https、無ければ http（serve.py 参照）
cd "$(dirname "$0")"
PORT="${1:-8010}"
echo "https://$(hostname -I | awk '{print $1}'):${PORT}/ で待受中（certs 無しなら http）"
exec python3 serve.py "$PORT"
