#!/usr/bin/env python3
"""HL Terminal の LAN 配信サーバー（https）。

port 8010 を https で配信する（certs/ の mkcert 証明書。無ければ従来どおり http で起動）。
CA 未導入のデバイスはブラウザの警告を通せば閲覧でき、certs/rootCA.pem を
ダウンロード・インストールすれば警告なしになる。
証明書の期限（発行から27ヶ月）が切れたら certs/ で mkcert を再実行して restart。
"""
import http.server
import os
import ssl
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(ROOT, "certs", "cert.pem")
KEY = os.path.join(ROOT, "certs", "key.pem")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8010


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)


if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    if os.path.exists(CERT) and os.path.exists(KEY):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        print(f"https:{PORT} で待受中", flush=True)
    else:
        print(f"certs なし（{CERT}）— http:{PORT} で配信", flush=True)
    srv.serve_forever()
