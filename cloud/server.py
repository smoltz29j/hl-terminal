#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["aiohttp>=3.9"]
# ///
"""HL Terminal クラウド版（ペーパートレード専用）のサーバー。

takerflow.com:8010 で動かす想定（Caddy が TLS 終端し 127.0.0.1:18010 へ中継）。
LAN 版 serve.py との違い:
  - ユーザー名+パスワード認証（data/users.json に scrypt ハッシュ、HMAC 署名の Cookie セッション）。未ログインは /login へ
  - 口座 JSON はユーザー別 data/users/<user>/paper-<net>.json（取引履歴 fills も口座 JSON の中）
  - 配信するのはホワイトリストの静的ファイルだけ（MetaMask SDK バンドルは再配布不可なので
    空のスタブを返す — index.html の <script> を壊さないため）
  - /cloud.js を動的生成して window.HLT_CLOUD を立てる → フロントは paper 固定・口座はここに保存
  - /api/paper/<net> GET/PUT: ログイン中ユーザーの口座 JSON を保存（rev で楽観ロック。別端末の古い書込は 409）
  - /healthz: 無認証の死活 + 配信中 JS の md5（deploy_takerflow.sh の検証用）

環境変数: HOST（既定 127.0.0.1）/ PORT（18010）/ HLT_DATA（data ディレクトリ、既定 cloud/data）/
          HLT_SECURE_COOKIE（既定 1。ローカル http 試験時のみ 0）
ユーザー追加/パスワード変更: `uv run cloud/server.py --set-password --user <name>`（対話。stdin がパイプなら 1 行読む）
ユーザー一覧: `--list-users` / 削除: `--delete-user <name>`（口座データは残す）
"""
import argparse
import asyncio
import base64
import getpass
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("HLT_DATA") or (ROOT / "cloud" / "data"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "18010"))
SECURE_COOKIE = os.environ.get("HLT_SECURE_COOKIE", "1") != "0"
COOKIE = "hlt_sess"
SESSION_TTL = 30 * 24 * 3600
NETS = ("mainnet", "testnet")
USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
# 配信する静的ファイル（これ以外は 404。certs/ tools/ docs/ .git 等は決して出さない）
STATIC = {"index.html", "duo.html", "style.css", "app.js", "hl-sign.js", "paper.js", "trade.js"}
# ログイン失敗の抑止: 同一 IP で LOCK_FAILS 回失敗したら LOCK_SEC 秒ロック
LOCK_FAILS, LOCK_SEC = 5, 600
DEMAND_WS = os.environ.get("HLT_DEMAND_WS", "wss://takerflow.com:8765/ws")

fails: dict[str, list] = {}  # ip -> [count, lock_until]
write_lock = asyncio.Lock()


# ---------- 認証（ユーザー別） ----------

def users_path() -> Path:
    return DATA / "users.json"


def load_users() -> dict:
    """{name: {salt, hash, set_at}}"""
    try:
        u = json.loads(users_path().read_text())
        return u if isinstance(u, dict) else {}
    except (OSError, ValueError):
        return {}


def save_users(u: dict):
    DATA.mkdir(parents=True, exist_ok=True)
    users_path().write_text(json.dumps(u, indent=1))
    os.chmod(users_path(), 0o600)


def hash_password(pw: str, salt: bytes) -> str:
    return hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, maxmem=2**26, dklen=32).hex()


def set_password(user: str, pw: str):
    if not USER_RE.match(user):
        sys.exit("ユーザー名は英数字で始まる 1〜32 文字（英数字 _ . -）にしてください")
    if len(pw) < 8:
        sys.exit("パスワードは 8 文字以上にしてください")
    u = load_users()
    salt = secrets.token_bytes(16)
    u[user] = {"salt": salt.hex(), "hash": hash_password(pw, salt), "set_at": int(time.time())}
    save_users(u)


def verify_password(user: str, pw: str) -> bool:
    a = load_users().get(user)
    if not a:
        hash_password(pw, b"x" * 16)  # 存在しないユーザーでも所要時間を揃える
        return False
    return hmac.compare_digest(hash_password(pw, bytes.fromhex(a["salt"])), a["hash"])


def secret_path() -> Path:
    return DATA / "secret"


def secret() -> bytes:
    p = secret_path()
    try:
        return bytes.fromhex(p.read_text().strip())
    except (OSError, ValueError):
        DATA.mkdir(parents=True, exist_ok=True)
        s = secrets.token_bytes(32)
        p.write_text(s.hex())
        os.chmod(p, 0o600)
        return s


def make_token(user: str) -> str:
    body = f"{int(time.time()) + SESSION_TTL}.{user}.{secrets.token_hex(8)}"
    sig = hmac.new(secret(), body.encode(), "sha256").hexdigest()
    return base64.urlsafe_b64encode(f"{body}.{sig}".encode()).decode()


def token_user(tok: str | None) -> str | None:
    """署名・期限が有効ならユーザー名、そうでなければ None（ユーザーが削除されていても None）"""
    if not tok:
        return None
    try:
        exp, user, nonce, sig = base64.urlsafe_b64decode(tok.encode()).decode().split(".")
    except Exception:
        return None
    body = f"{exp}.{user}.{nonce}"
    if not hmac.compare_digest(hmac.new(secret(), body.encode(), "sha256").hexdigest(), sig):
        return None
    if int(exp) <= time.time() or user not in load_users():
        return None
    return user


def client_ip(req: web.Request) -> str:
    # Caddy の reverse_proxy は X-Forwarded-For を付ける（127.0.0.1 からの直接アクセスはそのまま）
    xff = req.headers.get("X-Forwarded-For")
    return (xff.split(",")[0].strip() if xff else req.remote) or "?"


def current_user(req: web.Request) -> str | None:
    return token_user(req.cookies.get(COOKIE))


def logged_in(req: web.Request) -> bool:
    return current_user(req) is not None


def set_cookie(resp: web.StreamResponse, tok: str | None):
    if tok:
        resp.set_cookie(COOKIE, tok, max_age=SESSION_TTL, httponly=True, secure=SECURE_COOKIE, samesite="Lax", path="/")
    else:
        resp.del_cookie(COOKIE, path="/")


LOGIN_HTML = """<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HL Terminal — Login</title><link rel="icon" href="data:,">
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #1a1a19; color: #e8e6e3; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "Noto Sans JP", sans-serif; }
  form { background: #222221; border: 1px solid #3a3a38; border-radius: 8px; padding: 24px 28px; width: 300px; }
  h1 { font-size: 18px; margin: 0 0 4px; } h1 span { color: #c98500; font-size: 12px; margin-left: 8px; border: 1px solid #c98500; border-radius: 3px; padding: 0 5px; }
  p { margin: 0 0 14px; color: #9a9893; font-size: 12px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; margin: 6px 0 14px; background: #1a1a19; color: inherit;
          border: 1px solid #3a3a38; border-radius: 4px; font-size: 15px; }
  button { width: 100%; padding: 9px; background: #0ca30c; color: #fff; border: 0; border-radius: 4px; font-size: 14px; cursor: pointer; }
  .err { color: #e66767; margin: 0 0 10px; }
</style></head><body>
<form method="post" action="/login">
  <h1>HL Terminal<span>PAPER</span></h1>
  <p>ペーパートレード専用（クラウド版）/ Paper trading only</p>
  {err}
  <input type="hidden" name="next" value="{next}">
  <label>ユーザー名 / Username<input type="text" name="user" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus required></label>
  <label>パスワード / Password<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">ログイン / Sign in</button>
</form></body></html>"""


def login_page(err: str = "", nxt: str = "/", status: int = 200) -> web.Response:
    e = f'<p class="err">{html.escape(err)}</p>' if err else ""
    body = LOGIN_HTML.replace("{err}", e).replace("{next}", html.escape(nxt))
    return web.Response(text=body, content_type="text/html", status=status, headers={"Cache-Control": "no-store"})


def safe_next(nxt: str | None) -> str:
    # オープンリダイレクト防止: 自サイト内の相対パスだけ許可
    if not nxt or not nxt.startswith("/") or nxt.startswith("//"):
        return "/"
    return nxt


async def h_login_get(req: web.Request):
    if logged_in(req):
        raise web.HTTPFound(safe_next(req.query.get("next")))
    if not load_users():
        return login_page("ユーザー未登録です。サーバーで `server.py --set-password --user <name>` を実行してください", status=503)
    return login_page(nxt=safe_next(req.query.get("next")))


async def h_login_post(req: web.Request):
    form = await req.post()
    nxt = safe_next(form.get("next"))
    ip = client_ip(req)
    f = fails.setdefault(ip, [0, 0])
    if f[1] > time.time():
        return login_page(f"試行回数の上限です。{int((f[1] - time.time()) / 60) + 1} 分後に再試行してください", nxt, 429)
    user = str(form.get("user") or "").strip()
    pw = str(form.get("password") or "")
    if not USER_RE.match(user) or not verify_password(user, pw):
        await asyncio.sleep(0.5)
        f[0] += 1
        if f[0] >= LOCK_FAILS:
            f[0], f[1] = 0, time.time() + LOCK_SEC
        print(f"login failed from {ip} (user={user[:32]!r})", flush=True)
        return login_page("ユーザー名またはパスワードが違います / Wrong username or password", nxt, 401)
    fails.pop(ip, None)
    print(f"login ok from {ip} user={user}", flush=True)
    resp = web.HTTPFound(nxt)
    set_cookie(resp, make_token(user))
    raise resp


async def h_logout(req: web.Request):
    resp = web.HTTPFound("/login")
    set_cookie(resp, None)
    raise resp


# ---------- 静的配信 ----------

def file_md5(name: str) -> str:
    try:
        return hashlib.md5((ROOT / name).read_bytes()).hexdigest()
    except OSError:
        return ""


async def h_healthz(req: web.Request):
    return web.json_response({"ok": True, "md5": {n: file_md5(n) for n in ("app.js", "paper.js", "trade.js")}, "users": len(load_users())},
                             headers={"Cache-Control": "no-store"})


async def h_cloud_js(req: web.Request):
    # user はログアウトボタンの表示用（未ログインでも配信するが null）
    cfg = {"paperOnly": True, "api": "/api", "demand": DEMAND_WS, "user": current_user(req)}
    return web.Response(text=f"window.HLT_CLOUD = {json.dumps(cfg)};\n", content_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


async def h_sdk_stub(req: web.Request):
    # MetaMask SDK は再配布不可ライセンス + クラウド版はウォレット接続を持たないため空スタブ
    return web.Response(text="// cloud (paper-only) build: MetaMask SDK not bundled\n", content_type="application/javascript")


async def h_static(req: web.Request):
    name = req.match_info.get("name") or "index.html"
    if name not in STATIC:
        raise web.HTTPNotFound()
    if not logged_in(req):
        if name.endswith(".html"):
            raise web.HTTPFound("/login?next=" + req.path_qs if req.path_qs != "/" else "/login")
        raise web.HTTPUnauthorized()
    headers = {"Cache-Control": "no-cache"} if name.endswith(".html") else {}
    return web.FileResponse(ROOT / name, headers=headers)


# ---------- 口座 API ----------

def paper_path(user: str, net: str) -> Path:
    return DATA / "users" / user / f"paper-{net}.json"


def read_paper(user: str, net: str) -> dict:
    try:
        d = json.loads(paper_path(user, net).read_text())
        if isinstance(d, dict) and "rev" in d:
            return d
    except (OSError, ValueError):
        pass
    return {"rev": 0, "acct": None, "updated": 0}


def write_paper(user: str, net: str, d: dict):
    p = paper_path(user, net)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, separators=(",", ":")))
    if p.exists():
        p.replace(p.with_suffix(".prev.json"))  # 直前版を 1 世代だけ残す
    tmp.replace(p)


def need_auth_api(req: web.Request) -> str:
    user = current_user(req)
    if not user:
        raise web.HTTPUnauthorized(text='{"error":"unauthorized"}', content_type="application/json")
    return user


async def h_paper_get(req: web.Request):
    user = need_auth_api(req)
    net = req.match_info["net"]
    if net not in NETS:
        raise web.HTTPNotFound()
    d = read_paper(user, net)
    # If-None-Match に rev を入れて来たら変化なしは 304（5 秒ティックの帯域節約）
    if req.headers.get("If-None-Match") == str(d["rev"]):
        return web.Response(status=304, headers={"ETag": str(d["rev"])})
    return web.json_response(d, headers={"Cache-Control": "no-store", "ETag": str(d["rev"])})


async def h_paper_put(req: web.Request):
    user = need_auth_api(req)
    net = req.match_info["net"]
    if net not in NETS:
        raise web.HTTPNotFound()
    if req.content_length and req.content_length > 2_000_000:
        raise web.HTTPRequestEntityTooLarge(max_size=2_000_000, actual_size=req.content_length)
    try:
        body = await req.json()
        acct = body["acct"]
        base = int(body.get("rev", -1))
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest(text='{"error":"bad json"}', content_type="application/json")
    if not isinstance(acct, dict) or acct.get("v") != 1:
        raise web.HTTPBadRequest(text='{"error":"bad acct"}', content_type="application/json")
    async with write_lock:
        cur = read_paper(user, net)
        if base != cur["rev"] and not body.get("force"):
            return web.json_response({"error": "conflict", "rev": cur["rev"], "acct": cur["acct"]}, status=409)
        d = {"rev": cur["rev"] + 1, "acct": acct, "updated": int(time.time() * 1000)}
        write_paper(user, net, d)
    return web.json_response({"rev": d["rev"], "updated": d["updated"]}, headers={"Cache-Control": "no-store"})


def make_app() -> web.Application:
    app = web.Application(client_max_size=2_000_000)
    r = app.router
    r.add_get("/login", h_login_get)
    r.add_post("/login", h_login_post)
    r.add_post("/logout", h_logout)
    r.add_get("/healthz", h_healthz)
    r.add_get("/cloud.js", h_cloud_js)
    r.add_get("/metamask-sdk.bundle.js", h_sdk_stub)
    r.add_get("/api/paper/{net}", h_paper_get)
    r.add_put("/api/paper/{net}", h_paper_put)
    r.add_get("/", h_static)
    r.add_get("/{name}", h_static)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set-password", action="store_true", help="--user のパスワードを設定（新規ユーザーなら追加）して終了")
    ap.add_argument("--user", help="--set-password / --delete-user の対象ユーザー名")
    ap.add_argument("--list-users", action="store_true")
    ap.add_argument("--delete-user", metavar="NAME", help="ユーザーを削除（口座データ users/<name>/ は残す）")
    a = ap.parse_args()
    if a.list_users:
        for name, v in load_users().items():
            print(name, time.strftime("%Y-%m-%d %H:%M", time.localtime(v.get("set_at", 0))))
        return
    if a.delete_user:
        u = load_users()
        if a.delete_user not in u:
            sys.exit(f"ユーザー {a.delete_user} は存在しません")
        del u[a.delete_user]
        save_users(u)
        print(f"ユーザー {a.delete_user} を削除しました（{DATA / 'users' / a.delete_user} は残っています）")
        return
    if a.set_password:
        if not a.user:
            sys.exit("--user <name> を指定してください")
        pw = sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else getpass.getpass(f"{a.user} の新しいパスワード: ")
        set_password(a.user, pw)
        print(f"ユーザー {a.user} のパスワードを設定しました（{users_path()}）")
        return
    DATA.mkdir(parents=True, exist_ok=True)
    if not load_users():
        print("警告: ユーザー未登録 — ログイン不可。`server.py --set-password --user <name>` を実行してください", flush=True)
    print(f"HL Terminal cloud (paper-only) http://{HOST}:{PORT}  data={DATA}", flush=True)
    web.run_app(make_app(), host=HOST, port=PORT, print=None)


if __name__ == "__main__":
    main()
