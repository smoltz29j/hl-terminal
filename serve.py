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

    # 配信するのはホワイトリストのファイルだけ（cloud/server.py の STATIC と同じ考え方）。
    # 2026-11-10 総点検: 以前は「ドットパスと certs/ 以外は全部配信」だったため、プロジェクト直下の
    # hl-paper-password.txt（クラウド版の平文パスワード）・CLAUDE.md・tools/ のログ・cloud/server.py・
    # 写真などが LAN/VPN の誰からでも無認証で取得できた。フロントが読むファイルを増やしたら
    # ALLOWED に足すこと（足し忘れると 403 になる）。
    ALLOWED = {
        "index.html", "duo.html", "style.css", "cloud.js", "app.js", "hl-sign.js",
        "paper.js", "trade.js", "metamask-sdk.bundle.js",
        "certs/rootCA.pem",  # ローカル CA の公開証明書（端末への導入用）。key.pem は決して出さない
    }

    def _forbidden(self):
        rel = os.path.relpath(self.translate_path(self.path), ROOT).replace(os.sep, "/")
        if rel == ".":  # ルート = index.html（SimpleHTTPRequestHandler が解決する）
            return False
        return rel not in self.ALLOWED

    def send_head(self):
        if self._forbidden():
            self.send_error(403)
            return None
        return super().send_head()

    # HTML は no-cache（毎回サーバーに確認 = If-Modified-Since で 304 になるだけ）。
    # これが無いとブラウザが index.html/duo.html をヒューリスティックにキャッシュし、
    # 古い HTML が古い ?v= の JS を参照し続けて更新が届かない（iPhone Safari で実害、
    # 2026-08-21 には PC でも「表示が変わらない」が発生）。JS/CSS は ?v= バスターで
    # 更新されるためキャッシュ許容（no-cache にしない — 板1秒ポーリング等の負荷を増やさない）。
    def end_headers(self):
        if self.path.split("?")[0].split("/")[-1] in ("", "index.html", "duo.html"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

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
