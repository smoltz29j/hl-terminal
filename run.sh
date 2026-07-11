#!/bin/bash
# HL Terminal を LAN 向けに配信する（静的ファイルのみ）
cd "$(dirname "$0")"
PORT="${1:-8010}"
echo "http://$(hostname -I | awk '{print $1}'):${PORT}/ で待受中"
exec python3 -m http.server "$PORT" --bind 0.0.0.0
