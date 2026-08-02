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

    # 配信していいのは静的アセットだけ。ドットパス（.git 等）と certs/ の
    # rootCA.pem 以外（= TLS 秘密鍵 key.pem を含む）は 403 で遮断する
    def _forbidden(self):
        rel = os.path.relpath(self.translate_path(self.path), ROOT)
        parts = rel.split(os.sep)
        if any(p.startswith(".") for p in parts if p != "."):  # "." はルート自身
            return True
        if parts[0] == "certs" and parts[-1] != "rootCA.pem":
            return True
        return False

    def send_head(self):
        if self._forbidden():
            self.send_error(403)
            return None
        return super().send_head()

    def list_directory(self, path):
        # ディレクトリ一覧は出さない（certs/ 等の中身を露出させない）
        self.send_error(403)
        return None


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
