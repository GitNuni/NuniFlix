"""iPhone app notifications through Apple's push service (APNs).

The owner adds an APNs key once (Settings → System → iPhone app notifications): the .p8 file's text, its Key ID and
the Apple Developer Team ID, from developer.apple.com → Keys. Each iPhone that turns notifications on sends its device
token (store: apns_tokens). notify.push() sends to these as well as to web push subscriptions.
"""
import base64, json, threading, time

import httpx

import store

HOST = "https://api.push.apple.com"
_jwt = {"token": None, "at": 0, "kid": None}
_lock = threading.Lock()
_client = None


def settings():
    return store.config()["apns"]


def configured():
    c = settings()
    return bool(c["key"] and c["key_id"] and c["team_id"] and c["topic"])


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _token():
    """The signed JSON Web Token APNs wants, reused for 40 minutes (Apple refuses ones older than an hour)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    c = settings()
    with _lock:
        if _jwt["token"] and _jwt["kid"] == c["key_id"] and time.time() - _jwt["at"] < 2400:
            return _jwt["token"]
        key = serialization.load_pem_private_key(c["key"].strip().encode(), password=None)
        head = _b64(json.dumps({"alg": "ES256", "kid": c["key_id"]}).encode())
        claims = _b64(json.dumps({"iss": c["team_id"], "iat": int(time.time())}).encode())
        r, s = decode_dss_signature(key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
        sig = _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        _jwt.update(token=f"{head}.{claims}.{sig}", at=time.time(), kid=c["key_id"])
        return _jwt["token"]


def _http():
    global _client
    if _client is None:
        _client = httpx.Client(http2=True, timeout=10)
    return _client


def send(user_id, title, body, url="/"):
    """Notify every iPhone this person turned notifications on for. Tokens Apple says are gone are forgotten."""
    if not configured():
        return
    rows = store.q("select token from apns_tokens where user_id=?", (user_id,))
    if not rows:
        return
    c = settings()
    payload = json.dumps({"aps": {"alert": {"title": title, "body": body}, "sound": "default"}, "url": url})
    for r in rows:
        try:
            resp = _http().post(f"{HOST}/3/device/{r['token']}", content=payload, headers={
                "authorization": "bearer " + _token(), "apns-topic": c["topic"], "apns-push-type": "alert", "apns-priority": "10"})
        except httpx.HTTPError as e:
            print("apns:", type(e).__name__, flush=True)
            continue
        if resp.status_code == 410 or (resp.status_code == 400 and "BadDeviceToken" in resp.text):
            store.run("delete from apns_tokens where token=?", (r["token"],))
        elif resp.status_code >= 400:
            print("apns:", resp.status_code, resp.text[:200], flush=True)


def check():
    """(ok, message) for the settings page: does the key load and sign?"""
    if not configured():
        return False, "Add the key text, Key ID and Team ID."
    try:
        _jwt["token"] = None
        _token()
        return True, "Key looks good."
    except Exception as e:  # a pasted key that isn't a .p8
        return False, f"That key didn't load ({type(e).__name__}). Paste the whole .p8 file, including the BEGIN/END lines."
