# -*- coding: utf-8 -*-
"""凭证自动同步器：监听 AutoClaw 2.x 凭证文件变化（应用轮换 token 时会重写
account-credentials.enc），变化即重新解密并同步到 relay 的凭证源。
纯文件监听，零网络出站 —— 不触碰上游仓库"禁止固定节奏出站"红线。

用法：python watch_auth.py  （后台常驻）
"""
import json
import os
import sys
import time
from pathlib import Path

APPDATA = Path(os.environ["APPDATA"])
SRC = APPDATA / "AutoClaw-official"
OUT = Path.home() / ".autoclaw-relay" / "auth-compat"
STATE_DIR = Path.home() / ".openclaw-autoclaw"
HERE = Path(__file__).resolve().parent

sys.argv = ["x"]
import importlib.util
spec = importlib.util.spec_from_file_location(
    "a_switch", HERE.parent / "a_switch.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def sync():
    key = m._os_crypt_key(SRC)
    for acc_dir in (SRC / "accounts").iterdir():
        enc = acc_dir / "account-credentials.enc"
        if not enc.is_file():
            continue
        blob = enc.read_bytes()
        if blob[:3] != b"v10":
            continue
        plain = AESGCM(key).decrypt(blob[3:15], blob[15:], None)
        cred = json.loads(plain.decode("utf-8"))
        prof_p = acc_dir / "account-profile.json"
        prof = json.loads(prof_p.read_text(encoding="utf-8")).get("profile", {}) if prof_p.is_file() else {}
        auth = {
            "token": cred.get("accessToken"),
            "refreshToken": cred.get("refreshToken"),
            "deviceId": cred.get("deviceId") or "",
            "userInfo": {
                "user_id": cred.get("userId") or prof.get("numericUserId"),
                "user_name": cred.get("nickname") or prof.get("displayName"),
                "email": cred.get("email") or prof.get("email") or "",
            },
        }
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "auth.json").write_text(json.dumps(auth, ensure_ascii=False, indent=2), encoding="utf-8")
        (OUT / "Local State").write_bytes((SRC / "Local State").read_bytes())
        (OUT / "channel.json").write_bytes((SRC / "channel.json").read_bytes())
        # 同步 relay 凭证（relay 每请求重读，写完即生效）
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tok = auth["token"]
        tok = tok if tok.lower().startswith("bearer ") else f"Bearer {tok}"
        (STATE_DIR / "request-headers.json").write_text(
            json.dumps({"headers": {"X-Authorization": tok, "X-Client-Type": "pc"}}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        return True
    return False


def fingerprint():
    """只监听凭证相关文件：accounts/<hash>/account-credentials.enc + Local State。
    应用轮换 token 时会重写 account-credentials.enc（其 mtime 变化即轮换信号）。"""
    fp = {}
    acc = SRC / "accounts"
    if acc.is_dir():
        for sub in acc.iterdir():
            enc = sub / "account-credentials.enc"
            if enc.is_file():
                fp[str(enc)] = enc.stat().st_mtime
    ls = SRC / "Local State"
    fp[str(ls)] = ls.stat().st_mtime if ls.exists() else 0
    return fp


def main():
    state = fingerprint()
    print(f"[watch_auth] watching {SRC} ({len(state)} files)", flush=True)
    Path.home().joinpath(".autoclaw-relay/watch_auth.pid").write_text(str(os.getpid()), encoding="utf-8")
    synced_at = 0
    while True:
        time.sleep(5)  # 本地文件轮询，无网络
        now = fingerprint()
        if now == state:
            continue
        state = now
        if time.time() - synced_at < 30:  # 防抖：30 秒内不重复同步
            continue
        try:
            if sync():
                synced_at = time.time()
                print(f"[watch_auth] credentials synced at {time.strftime('%H:%M:%S')}", flush=True)
        except Exception as e:
            print(f"[watch_auth] sync error: {type(e).__name__}: {e}", flush=True)
            time.sleep(30)


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            pf = Path.home() / ".autoclaw-relay/watch_auth.pid"
            if pf.exists() and pf.read_text(encoding="utf-8").strip() == str(os.getpid()):
                pf.unlink()
        except Exception:
            pass
