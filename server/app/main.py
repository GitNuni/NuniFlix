"""NuniFlix API. Clients (web app, iPhone app) sign in, then send `Authorization: Bearer <token>`.
The web app uses the same token as an HttpOnly cookie; cookie-authenticated writes must carry `X-NF: 1`.
API docs: /api/docs
"""
import html, ipaddress, json, math, os, re, secrets, threading, time
from typing import Literal, Optional

import httpx
from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import random

import accounts, apns, arr, history, media, notify, office, player, store, subtitles, tmdb

VERSION = "0.4.0"
COOKIE = "nf_token"
app = FastAPI(title="NuniFlix", version=VERSION, docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")


@app.exception_handler(arr.ArrError)
def _arr_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=502)


@app.exception_handler(accounts.LoginError)
def _login_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(player.PlayError)
def _play_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(subtitles.SubError)
def _sub_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(store.LinkError)
def _link_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=409)


# ---------- auth plumbing ----------
def client_ip(request: Request):
    ip = request.client.host if request.client else ""
    try:
        private = ipaddress.ip_address(ip).is_private
    except ValueError:
        private = False
    if private:  # behind Nginx Proxy Manager: X-Real-IP is set (not appended) by it; in X-Forwarded-For only the last hop is
        fwd = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
        try:
            return str(ipaddress.ip_address(fwd))
        except ValueError:
            return ip
    return ip


def _token(request: Request):
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip(), False
    return request.cookies.get(COOKIE), True


def current_user(request: Request):
    token, from_cookie = _token(request)
    user = store.session_user(token)
    if not user:
        raise HTTPException(401, "Sign in first.")
    if from_cookie and request.method not in ("GET", "HEAD") and request.headers.get("x-nf") != "1":
        raise HTTPException(403, "Missing X-NF header.")
    return user


def admin_user(user=Depends(current_user)):
    if not store.is_admin(user):
        raise HTTPException(403, "Admins only.")
    return user


def owner_user(user=Depends(current_user)):
    """Servers, keys and sign-in settings: only the owner. (An admin you promote can approve and manage people, but
    pointing NuniFlix at a different Plex/Jellyfin could make them the owner.)"""
    if not user["owner"]:
        raise HTTPException(403, "Only the owner can change this.")
    return user


def public_user(u):
    return {"id": u["id"], "name": u["name"], "source": u["source"], "admin": store.is_admin(u), "owner": bool(u["owner"]),
            "accounts": [{"id": i["id"], "source": i["source"], "name": i["name"]} for i in store.identities(u["id"])]}


def base_url(request: Request):
    fixed = store.config()["site_url"]
    if fixed:  # one address for everything, so Discord always sees the same redirect
        return fixed.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{proto}://{request.headers.get('host', request.url.netloc)}"


def signed_in(request: Request, user, device, identity=None):
    token = store.new_session(user["id"], device, identity)
    resp = JSONResponse({"token": token, "user": public_user(user)})
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp.set_cookie(COOKIE, token, max_age=90 * 86400, httponly=True, secure=secure, samesite="lax")
    return resp


# ---------- sign in ----------
@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION}


@app.get("/api/auth/options")
def auth_options():
    c = store.config()
    return {"jellyfin": bool(c["jellyfin_login"] and c["jellyfin"]["url"]), "plex": bool(c["plex_login"] and c["plex"]["url"]),
            "discord": accounts.discord_ready(c), "fluxer": accounts.fluxer_ready(c), "setup": setup_needed(), "name": c.get("brand") or "Nuni"}


def feature(user, k):
    """Swipe / Movie Match: on for this person? The owner turns each one on or off, for everyone or per person."""
    return bool(store.config()[k + "_on"]) and (store.is_admin(user) or store.perms(user)["can_" + k])


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    n = store.app_name()
    return JSONResponse({"name": n, "short_name": n, "start_url": "/", "scope": "/", "display": "standalone",
                         "background_color": "#000000", "theme_color": "#0b0b0f",
                         "icons": [{"src": "icon.svg", "sizes": "any", "type": "image/svg+xml"},
                                   {"src": "icon-180.png", "sizes": "180x180", "type": "image/png"},
                                   {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}]},
                        media_type="application/manifest+json")


class JellyfinLogin(BaseModel):
    username: str = Field(max_length=128)
    password: str = Field(max_length=256)
    device: Optional[str] = Field(None, max_length=80)


@app.post("/api/auth/jellyfin")
def login_jellyfin(body: JellyfinLogin, request: Request):
    ip = client_ip(request)
    if accounts.too_many(ip):
        raise HTTPException(429, "Too many tries. Wait 15 minutes.")
    ident = accounts.jellyfin_identity(body.username.strip(), body.password, body.device or "Web")
    if not ident:
        accounts.failed(ip)
        raise HTTPException(401, "Wrong username or password.")
    user = store.login_identity(ident)
    if user["blocked"]:
        raise HTTPException(403, "This account is blocked.")
    return signed_in(request, user, body.device or "Web", ident["id"])


@app.post("/api/auth/plex/start")
def login_plex_start():
    return accounts.plex_start()


class PlexCheck(BaseModel):
    state: str = Field(max_length=100)
    device: Optional[str] = Field(None, max_length=80)


@app.post("/api/auth/plex/check")
def login_plex_check(body: PlexCheck, request: Request):
    ident = accounts.plex_check(body.state)
    if not ident:
        return JSONResponse({"pending": True}, status_code=202)
    user = store.login_identity(ident)
    if user["blocked"]:
        raise HTTPException(403, "This account is blocked.")
    return signed_in(request, user, body.device or "Web", ident["id"])


class DiscordCheck(BaseModel):
    state: str = Field(max_length=100)
    device: Optional[str] = Field(None, max_length=80)


@app.post("/api/auth/discord/start")
def login_discord_start(request: Request):
    return accounts.discord_start(base_url(request) + "/api/auth/discord/callback")


@app.get("/api/auth/discord/callback", include_in_schema=False)
def login_discord_callback(state: str = "", code: str = "", error: str = "", guild_id: str = ""):
    if not state and guild_id:  # Discord sends people here after inviting the bot with this redirect picked
        msg = f"The bot is in your Discord server now. You can close this window and go back to {store.app_name()}."
    elif not state:
        msg = ("This address is where Discord sends people back after they sign in. Paste it into the Discord developer "
               "portal under OAuth2 → Redirects. You don't need to open it.")
    else:
        msg = accounts.discord_callback(state[:100], code[:200], error)
    return _window_page(msg)


def _window_page(msg):
    """What the sign-in window shows when Discord/Fluxer send someone back (it closes itself)."""
    return HTMLResponse(f"""<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(store.app_name())}</title><body style="font:17px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;
text-align:center;padding:20px;background:#000;color:#fff"><p>{html.escape(msg)}</p><script>setTimeout(()=>window.close(),1200)</script>""")


@app.post("/api/auth/discord/check")
def login_discord_check(body: DiscordCheck, request: Request):
    ident = accounts.discord_check(body.state)
    if not ident:
        return JSONResponse({"pending": True}, status_code=202)
    if store.config()["discord_needs_link"]:
        row = store.q1("select user_id from identities where id=?", (ident["id"],))
        if not row or not store.q1("select 1 from identities where user_id=? and source in ('plex','jellyfin')", (row["user_id"],)):
            raise HTTPException(403, "Sign in with Plex or Jellyfin first, then link your Discord under You → Account. "
                                     "After that, Discord signs you in.")
    user = store.login_identity(ident)
    if user["blocked"]:
        raise HTTPException(403, "This account is blocked.")
    return signed_in(request, user, body.device or "Web", ident["id"])


@app.post("/api/auth/fluxer/start")
def login_fluxer_start(request: Request):
    return accounts.fluxer_start(base_url(request) + "/api/auth/fluxer/callback")


@app.get("/api/auth/fluxer/callback", include_in_schema=False)
def login_fluxer_callback(state: str = "", code: str = "", error: str = ""):
    if not state:
        msg = ("This address is where Fluxer sends people back after they sign in. Paste it into your Fluxer app's "
               "OAuth2 redirects. You don't need to open it.")
    else:
        msg = accounts.fluxer_callback(state[:100], code[:200], error)
    return _window_page(msg)


@app.post("/api/auth/fluxer/check")
def login_fluxer_check(body: DiscordCheck, request: Request):
    ident = accounts.fluxer_check(body.state)
    if not ident:
        return JSONResponse({"pending": True}, status_code=202)
    if store.config()["fluxer_needs_link"]:
        row = store.q1("select user_id from identities where id=?", (ident["id"],))
        if not row or not store.q1("select 1 from identities where user_id=? and source in ('plex','jellyfin')", (row["user_id"],)):
            raise HTTPException(403, "Sign in with Plex or Jellyfin first, then link your Fluxer under You \u2192 Account. "
                                     "After that, Fluxer signs you in.")
    user = store.login_identity(ident)
    if user["blocked"]:
        raise HTTPException(403, "This account is blocked.")
    return signed_in(request, user, body.device or "Web", ident["id"])


# ---------- TV sign-in ----------
# Typing a password on a TV remote is miserable: the TV shows a short code (and a QR code), the person opens
# NuniFlix on their phone, already signed in, and approves it. The TV then gets its own session.
_tv, _tv_lock = {}, threading.Lock()  # code -> {"state", "t", "user"}
TV_ALPHA, TV_TTL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 600


def _tv_code(code):
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())[:8]


@app.post("/api/auth/tv/start")
def tv_start(request: Request):
    with _tv_lock:
        now = time.time()
        for k in [k for k, v in _tv.items() if now - v["t"] > TV_TTL]:
            del _tv[k]
        if len(_tv) >= 500:
            raise HTTPException(429, "Too many sign-ins in progress. Try again in a few minutes.")
        code = "".join(secrets.choice(TV_ALPHA) for _ in range(6))
        while code in _tv:
            code = "".join(secrets.choice(TV_ALPHA) for _ in range(6))
        state = secrets.token_urlsafe(24)
        _tv[code] = {"state": state, "t": now, "user": None}
    base = base_url(request)
    return {"code": code, "state": state, "url": f"{base}/?tv={code}", "link": f"{base}/?tv", "expires": TV_TTL}


class TvCheck(BaseModel):
    state: str = Field(max_length=100)
    device: Optional[str] = Field(None, max_length=80)


@app.post("/api/auth/tv/check")
def tv_check(body: TvCheck, request: Request):
    with _tv_lock:
        code = next((k for k, v in _tv.items() if secrets.compare_digest(v["state"], body.state)), None)
        entry = _tv.get(code) if code else None
        if not entry or time.time() - entry["t"] > TV_TTL:
            raise HTTPException(410, "That code expired. Getting a new one.")
        if not entry["user"]:
            return JSONResponse({"pending": True}, status_code=202)
        del _tv[code]
    user = store.q1("select * from users where id=?", (entry["user"],))
    if not user or user["blocked"]:
        raise HTTPException(403, "This account is blocked.")
    return signed_in(request, user, body.device or "Apple TV")


class TvApprove(BaseModel):
    code: str = Field(max_length=20)


@app.post("/api/auth/tv/approve")
def tv_approve(body: TvApprove, request: Request, user=Depends(current_user)):
    ip = client_ip(request)
    if accounts.too_many(ip):
        raise HTTPException(429, "Too many tries. Wait 15 minutes.")
    code = _tv_code(body.code)
    with _tv_lock:
        entry = _tv.get(code)
        if entry and time.time() - entry["t"] <= TV_TTL and not entry["user"]:
            entry["user"] = user["id"]
            return {"ok": True}
    accounts.failed(ip)
    raise HTTPException(404, "That code isn't right, or it expired. Check the TV.")


# ---------- linking sign-in accounts ----------
# Same sign-in flows, but the account is attached to whoever is signed in instead of opening its own.
def _linked(user, ident):
    store.link_identity(user["id"], ident)
    return public_user(store.q1("select * from users where id=?", (user["id"],)))


@app.post("/api/link/jellyfin")
def link_jellyfin(body: JellyfinLogin, request: Request, user=Depends(current_user)):
    ip = client_ip(request)
    if accounts.too_many(ip):
        raise HTTPException(429, "Too many tries. Wait 15 minutes.")
    ident = accounts.jellyfin_identity(body.username.strip(), body.password, body.device or "Web")
    if not ident:
        accounts.failed(ip)
        raise HTTPException(401, "Wrong username or password.")
    return _linked(user, ident)


@app.post("/api/link/plex/start")
def link_plex_start(user=Depends(current_user)):
    return accounts.plex_start()


@app.post("/api/link/plex/check")
def link_plex_check(body: PlexCheck, user=Depends(current_user)):
    ident = accounts.plex_check(body.state)
    return _linked(user, ident) if ident else JSONResponse({"pending": True}, status_code=202)


@app.post("/api/link/discord/start")
def link_discord_start(request: Request, user=Depends(current_user)):
    return accounts.discord_start(base_url(request) + "/api/auth/discord/callback")


@app.post("/api/link/discord/check")
def link_discord_check(body: DiscordCheck, user=Depends(current_user)):
    ident = accounts.discord_check(body.state)
    return _linked(user, ident) if ident else JSONResponse({"pending": True}, status_code=202)


@app.post("/api/link/fluxer/start")
def link_fluxer_start(request: Request, user=Depends(current_user)):
    return accounts.fluxer_start(base_url(request) + "/api/auth/fluxer/callback")


@app.post("/api/link/fluxer/check")
def link_fluxer_check(body: DiscordCheck, user=Depends(current_user)):
    ident = accounts.fluxer_check(body.state)
    return _linked(user, ident) if ident else JSONResponse({"pending": True}, status_code=202)


class Unlink(BaseModel):
    id: str = Field(max_length=100)


@app.post("/api/unlink")
def unlink(body: Unlink, user=Depends(current_user)):
    store.unlink_identity(user["id"], body.id)
    return public_user(store.q1("select * from users where id=?", (user["id"],)))


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token, _ = _token(request)
    if token:
        store.end_session(token)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(current_user)):
    admin = store.is_admin(user)
    p = store.perms(user)
    return public_user(user) | {
        "perms": p | ({"can_movie": True, "can_tv": True, "request_4k": True} if admin else {}),
        "quota": {"movie": quota(user, "movie"), "tv": quota(user, "tv")},
        "has4k": {"movie": arr.has("radarr4k"), "tv": arr.has("sonarr4k")},
        "prefs": store.prefs(user),
        "features": {"swipe": feature(user, "swipe"), "match": feature(user, "match")},
        "home_off": store.config()["home_off"] + ([] if store.config()["office_on"] else ["office"]),
    }


class Prefs(BaseModel):
    push: Optional[bool] = None
    discord: Optional[bool] = None
    auto_next: Optional[bool] = None
    home: Optional[list[str]] = Field(None, max_length=10)  # Home rows, in order
    autoplay: Optional[bool] = None  # trailers play by themselves (muted) on title pages and the featured banner
    season: Optional[bool] = None  # seasonal background (leaves, snow, the odd horror cameo): web/season.js
    theme: Optional[Literal["nuniflix", "repertory", "premiere", "nunitech", "blockbuster", "retro", "atomic", "horror"]] = None


@app.post("/api/me/prefs")
def set_prefs(body: Prefs, user=Depends(current_user)):
    p = store.prefs(user) | {k: v for k, v in body.model_dump().items() if v is not None}
    if body.home is not None:
        p["home"] = [r for r in dict.fromkeys(body.home) if r in store.HOME_ROWS]
        p["home_v"] = 4
    store.run("update users set prefs=? where id=?", (json.dumps(p), user["id"]))
    return {"prefs": p}


# ---------- phone notifications (Web Push) ----------
@app.get("/api/push/key")
def push_key(user=Depends(current_user)):
    return {"key": notify.vapid_public(), "enabled": store.config()["notify"]["push"]}


PUSH_HOSTS = r"^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w-]+(\.[\w-]+)*\.push\.apple\.com|[\w-]+\.notify\.windows\.com)/"


class PushSub(BaseModel):
    endpoint: str = Field(max_length=1000, pattern=PUSH_HOSTS)  # browser push services only
    keys: dict


@app.post("/api/push/subscribe")
def push_subscribe(body: PushSub, user=Depends(current_user)):
    k = body.keys
    if not (isinstance(k.get("p256dh"), str) and isinstance(k.get("auth"), str)):
        raise HTTPException(400, "Bad subscription.")
    store.run("insert or replace into push_subs values(?,?,?,?,?)",
              (body.endpoint, user["id"], k["p256dh"][:200], k["auth"][:100], time.time()))
    store.run("delete from push_subs where user_id=? and endpoint not in "
              "(select endpoint from push_subs where user_id=? order by created desc limit 10)", (user["id"], user["id"]))
    return {"ok": True}


class PushEnd(BaseModel):
    endpoint: str = Field(max_length=1000)


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushEnd, user=Depends(current_user)):
    store.run("delete from push_subs where endpoint=? and user_id=?", (body.endpoint, user["id"]))
    return {"ok": True}


class ApnsToken(BaseModel):
    token: str = Field(pattern=r"^[0-9a-f]{64,200}$")


@app.get("/api/push/apns")
def apns_status(user=Depends(current_user)):
    """Can the iPhone app get notifications here (has the owner added an APNs key)?"""
    return {"configured": apns.configured()}


@app.post("/api/push/apns")
def apns_register(body: ApnsToken, user=Depends(current_user)):
    """The iPhone app's device token, after the person allowed notifications."""
    if not apns.configured():
        raise HTTPException(400, "The owner hasn't set up iPhone notifications yet (Settings → System).")
    store.run("insert or replace into apns_tokens values(?,?,?)", (body.token, user["id"], time.time()))
    return {"ok": True}


@app.post("/api/push/apns/remove")
def apns_remove(body: ApnsToken, user=Depends(current_user)):
    store.run("delete from apns_tokens where token=? and user_id=?", (body.token, user["id"]))
    return {"ok": True}


@app.post("/api/push/test")
def push_test(user=Depends(current_user)):
    if not store.q1("select 1 from push_subs where user_id=?", (user["id"],)) and not store.q1("select 1 from apns_tokens where user_id=?", (user["id"],)):
        raise HTTPException(400, "This device isn't signed up for notifications yet.")
    notify._pool.submit(notify.push, user["id"], store.app_name(), "Notifications are working.", "/")
    return {"ok": True}


# ---------- browse ----------
@app.get("/api/search")
def search(q: str, type: Optional[Literal["movie", "tv"]] = None, user=Depends(current_user)):
    q = q.strip()[:100]
    if len(q) < 2:
        return {"results": []}
    results = arr.search(q, type)
    _overlay_requests(results)
    return {"results": results}


@app.get("/api/item/tvtmdb/{tmdb_id}")
def get_item_by_tmdb(tmdb_id: int, user=Depends(current_user)):
    """Shows from the streaming catalogs arrive with a TMDB id; Sonarr needs the TVDB one."""
    tvdb = tmdb.tvdb_id(tmdb_id)
    if not tvdb:
        raise HTTPException(404, "Sonarr can't find this show yet.")
    return get_item("tv", tvdb, user)


def season_eps(tvdb, n, tmdb_id=None):
    eps = arr.season_episodes(tvdb, n)
    if eps is None:
        if not (tmdb_id and tmdb.key()):
            raise HTTPException(404, "Episode lists for shows that aren't in Sonarr yet need a TMDB key.")
        eps = tmdb.season_episodes(tmdb_id, n)
    return eps


@app.get("/api/item/tv/{tvdb}/season/{n}")
def get_season(tvdb: int, n: int, user=Depends(current_user)):
    """One season's episodes, each with its state: available / pending / processing / none."""
    it = arr.item("tv", tvdb)
    eps = season_eps(tvdb, n, it.get("tmdb"))
    pend = store.q("select seasons, episodes, user_id from requests r where type='tv' and ext_id=? and is4k=0 and status='pending'", (tvdb,))
    whole = any(not p["seasons"] or (n in json.loads(p["seasons"]) and not p["episodes"]) for p in pend)
    waiting = {e for p in pend if p["episodes"] and n in json.loads(p["seasons"]) for e in json.loads(p["episodes"])}
    today = time.strftime("%Y-%m-%d")
    for e in eps:
        e["status"] = ("available" if e["have"] else "pending" if whole or e["n"] in waiting
                       else "processing" if e["monitored"] and (e["air_date"] or "9") <= today else "none")
        e["aired"] = bool(e["air_date"]) and e["air_date"] <= today
    return {"season": n, "episodes": eps}


@app.get("/api/item/{kind}/{ext_id}")
def get_item(kind: Literal["movie", "tv"], ext_id: int, user=Depends(current_user)):
    it = arr.item(kind, ext_id)
    _overlay_requests([it])
    reqs = store.q("select r.*, u.name as user_name from requests r join users u on u.id=r.user_id "
                   "where r.type=? and r.ext_id=? order by r.created desc limit 10", (kind, ext_id))
    it["requests"] = [shape_request(r) if store.is_admin(user) or r["user_id"] == user["id"] else _anon(shape_request(r))
                      for r in reqs]
    it["streaming"] = tmdb.streaming_on(kind, it.get("tmdb"))
    it["issues"] = store.q1("select count(*) n from issues where type=? and ext_id=? and status='open'", (kind, ext_id))["n"]
    return it


@app.get("/api/watch/{kind}/{ext_id}")
def watch_links(kind: Literal["movie", "tv"], ext_id: int, user=Depends(current_user)):
    """Links to open this title on Jellyfin / Plex, for whichever of those this person has linked."""
    mine = {i["source"] for i in store.identities(user["id"])} & {"jellyfin", "plex"}
    return media.links(kind, ext_id, mine or {"jellyfin", "plex"})


# ---------- watching in the app (player.py) ----------
@app.get("/api/play/{kind}/{ext_id}")
def play_options(kind: Literal["movie", "tv"], ext_id: int, user=Depends(current_user)):
    """What this person can play of a title, from their own Plex/Jellyfin: the movie, or the show's episodes."""
    return player.options(user, kind, ext_id)


class PlayStart(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9-]{1,64}$")
    offset: float = Field(0, ge=0, le=86400)
    platform: Literal["ios", "tvos", "web"] = "ios"  # web: browsers without built-in HLS (gets H.264 + stereo AAC)
    subtitle: Optional[int] = Field(None, ge=0, le=100000)  # a Plex/Jellyfin track to burn in; 0 = none


@app.post("/api/play/start")
def play_start(body: PlayStart, user=Depends(current_user)):
    return player.start(user, body.id, body.offset, body.platform, body.subtitle)


# ---------- subtitles (subtitles.py) ----------
ITEM_ID = r"^[A-Za-z0-9-]{1,64}$"


@app.get("/api/subs/{item_id}")
def subtitle_tracks(item_id: str = Path(pattern=ITEM_ID), user=Depends(current_user)):
    """The subtitle tracks this movie/episode already has on the person's Plex/Jellyfin."""
    return subtitles.tracks(user, item_id) | {"provider": subtitles.settings()["source"]}


@app.get("/api/subs/{item_id}/search")
def subtitle_search(kind: Literal["movie", "tv"], ext_id: int, item_id: str = Path(pattern=ITEM_ID),
                    season: Optional[int] = None, episode: Optional[int] = None,
                    language: Optional[str] = Query(None, pattern=r"^[a-z]{2}$"), user=Depends(current_user)):
    return subtitles.search(user, kind, ext_id, item_id, season, episode, language)


class SubGet(BaseModel):
    kind: Literal["movie", "tv"]
    id: str = Field(max_length=300)  # the search result's id
    provider: Literal["plex", "jellyfin", "opensubtitles"]


@app.post("/api/subs/{item_id}/get")
def subtitle_get(body: SubGet, item_id: str = Path(pattern=ITEM_ID), user=Depends(current_user)):
    return subtitles.get(user, body.kind, item_id, body.id, body.provider)


@app.get("/api/subtitles/{file_id}.vtt", include_in_schema=False)
def subtitle_file(file_id: str, user=Depends(current_user)):
    path = subtitles.vtt_path(file_id)
    if not path:
        raise HTTPException(404, "No such subtitles.")
    with open(path, encoding="utf-8") as f:
        return Response(f.read(), media_type="text/vtt; charset=utf-8", headers={"Cache-Control": "private, max-age=86400"})


class PlayProgress(BaseModel):
    session: str = Field(max_length=100)
    position: float = Field(ge=0, le=86400)
    duration: Optional[float] = Field(None, ge=0, le=86400)
    state: Literal["playing", "paused", "stopped"]


@app.post("/api/play/progress")
def play_progress(body: PlayProgress, user=Depends(current_user)):
    player.progress(user, body.session, body.position, body.state, body.duration)
    return {"ok": True}


@app.get("/api/stream/{sid}/{path:path}", include_in_schema=False)
def stream(sid: str, path: str, request: Request):
    """The video itself, passed through from Plex/Jellyfin. The unguessable stream id is the key (see player.py)."""
    status, headers, body = player.fetch(sid, path, request.url.query, request.headers.get("range"))
    if isinstance(body, bytes):
        return Response(body, status_code=status, headers=headers)
    return StreamingResponse(body, status_code=status, headers=headers)


@app.get("/api/home/foryou")
def home_foryou(user=Depends(current_user)):
    """'Because you watched…' rows from this person's own watch history."""
    if not tmdb.key():
        return {"rows": []}
    rows = arr.cached(f"foryou:{user['id']}", 1800, lambda: history.for_you(user["id"]))
    for r in rows:
        _overlay_requests(r["items"])
    return {"rows": rows}


# ---------- swipe mode ----------
@app.get("/api/swipe/feed")
def swipe_feed(user=Depends(current_user)):
    """A shuffled stack: what you'd probably like (from your history), what's trending, what's popular. Nothing you have or already swiped."""
    if not feature(user, "swipe"):
        raise HTTPException(403, "Swipe is turned off.")
    if not tmdb.key():
        raise HTTPException(400, "Swipe mode needs a TMDB key (Settings → Requests).")
    done = {(r["type"], r["tmdb"]) for r in store.q("select type, tmdb from swipes where user_id=?", (user["id"],))}
    pools = [x for row in arr.cached(f"foryou:{user['id']}", 1800, lambda: history.for_you(user["id"])) for x in row["items"]]
    pools += arr.safe(tmdb.trending_quick, [])
    for page in random.sample(range(1, 11), 3):
        pools += arr.safe(lambda: tmdb.popular("movie", page), [])
    pools = [x for x in pools if x["type"] == "movie"]  # movies only for now
    _overlay_requests(pools)
    have = media.library_movies()  # also on Plex/Jellyfin, even if Radarr doesn't know about it
    seen, out = set(), []
    for x in pools:
        k = (x["type"], x["tmdb"])
        if k in seen or k in done or x["status"] != "none" or x["tmdb"] in have or not x.get("backdrop") and not x.get("poster"):
            continue
        seen.add(k)
        out.append(x)
    head, tail = out[:10], out[10:]  # keep the most personal picks near the top, shuffle the rest in
    random.shuffle(tail)
    return {"items": (head + tail)[:40]}


class Swipe(BaseModel):
    type: Literal["movie", "tv"]
    tmdb: int
    action: Literal["like", "skip"]


@app.post("/api/swipe")
def swipe(body: Swipe, user=Depends(current_user)):
    if not feature(user, "swipe"):
        raise HTTPException(403, "Swipe is turned off.")
    store.run("insert or replace into swipes values(?,?,?,?,?)", (user["id"], body.type, body.tmdb, body.action, time.time()))
    return {"ok": True}


# ---------- movie match: two people swipe the same stack until they both like one ----------
# The host (signed in) makes a link; whoever opens it swipes without signing in. The code is the only key.
MATCH_KEYS = ("type", "tmdb", "id", "title", "year", "poster", "backdrop", "overview", "rating", "status")


MOODS = {"comedy": {"Comedy"}, "scary": {"Horror", "Thriller", "Mystery"}, "action": {"Action", "Science Fiction", "Adventure"},
         "drama": {"Drama", "Romance"}, "family": {"Family", "Animation"}}
RUNTIMES = {"short": 100, "under2": 120}


def _match_deck(runtime=None, mood=None):
    """60 random movies that are in the library right now (optionally short ones / one mood), so a match can be watched tonight."""
    lib = [m for m in arr.safe(arr.movie_lib, {}).values() if m.get("hasFile")
           and (not runtime or 0 < (m.get("runtime") or 0) <= RUNTIMES[runtime])
           and (not mood or MOODS[mood] & set(m.get("genres") or []))]
    random.shuffle(lib)
    items = [arr.shape_movie(m) for m in lib[:80]]
    seen, deck = set(), []
    for x in items:
        if x.get("tmdb") and x["tmdb"] not in seen and x.get("poster"):
            seen.add(x["tmdb"])
            deck.append({k: x.get(k) for k in MATCH_KEYS})
    return deck[:60]


class MatchNew(BaseModel):
    runtime: Optional[Literal["short", "under2"]] = None
    mood: Optional[Literal["comedy", "scary", "action", "drama", "family"]] = None


@app.post("/api/match")
def match_create(request: Request, body: Optional[MatchNew] = None, user=Depends(current_user)):
    if not feature(user, "match"):
        raise HTTPException(403, "Movie Match is turned off.")
    body = body or MatchNew()
    deck = _match_deck(body.runtime, body.mood)  # always the owner's library, whoever starts it
    if len(deck) < 5:
        raise HTTPException(400, "Not enough movies in your library fit those picks. Try a wider one."
                            if body.runtime or body.mood else "There aren't enough movies to swipe on yet.")
    code, key, now = secrets.token_urlsafe(9), secrets.token_urlsafe(18), time.time()
    store.run("delete from match_sessions where expires<?", (now,))
    store.run("insert into match_sessions(code,host_id,guest_name,deck,created,expires,host_key) values(?,?,?,?,?,?,?)",
              (code, user["id"], None, json.dumps(deck), now, now + 2 * 86400, key))
    return {"code": code, "key": key, "url": f"{base_url(request)}/?match={code}"}


@app.get("/api/match/mine")
def match_mine(request: Request, user=Depends(current_user)):
    """Your newest match that's still open, so you can carry on instead of starting a second stack."""
    m = store.q1("select * from match_sessions where host_id=? and expires>? order by created desc limit 1", (user["id"], time.time()))
    return {"match": {"code": m["code"], "url": f"{base_url(request)}/?match={m['code']}", "guest": m["guest_name"],
                      "created": m["created"]} if m else None}


def _session(code):
    m = store.q1("select * from match_sessions where code=?", (code,))
    if not store.config()["match_on"]:
        raise HTTPException(404, "Movie Match is turned off.")
    if not m or m["expires"] < time.time():
        raise HTTPException(404, "This movie match link has expired. Ask for a new one.")
    return m


def _who(request, m, claim=False):
    """(side, key). Sides are devices: the device that made the link is the host, the first other device to join is
    the guest (even if it's signed in as the same person, e.g. testing with two phones). Everyone else is turned away."""
    key = request.headers.get("x-match-key", "")
    if key and m["host_key"] and secrets.compare_digest(key, m["host_key"]):
        return "host", key
    if key and m["guest_key"] and secrets.compare_digest(key, m["guest_key"]):
        return "guest", key
    if request.query_params.get("as") == "host":  # the host continuing from inside their app
        token, _ = _token(request)
        u = store.session_user(token) if token else None
        if u and u["id"] == m["host_id"]:
            return "host", m["host_key"]
    if not m["guest_key"]:
        if not claim:
            return "guest", None
        k = secrets.token_urlsafe(18)
        store.run("update match_sessions set guest_key=? where code=? and guest_key is null", (k, m["code"]))
        if store.q1("select guest_key from match_sessions where code=?", (m["code"],))["guest_key"] == k:
            return "guest", k
    raise HTTPException(409, "This match already has two people. Ask for a new link.")


def _matched(m):
    deck = {d["tmdb"]: d for d in json.loads(m["deck"])}
    rows = store.q("select tmdb, max(created) t from match_votes where code=? and vote='like' group by tmdb "
                   "having count(distinct who)=2 order by t", (m["code"],))
    return [deck[r["tmdb"]] for r in rows if r["tmdb"] in deck]


CODE = Path(min_length=6, max_length=20, pattern=r"^[\w-]+$")


@app.get("/api/match/{code}")
def match_get(request: Request, code: str = CODE, light: bool = False):
    m = _session(code)
    who, key = _who(request, m)
    other = "guest" if who == "host" else "host"
    out = {"who": who, "key": key, "joined": bool(m["guest_key"]), "host": store.q1("select name from users where id=?", (m["host_id"],))["name"], "guest": m["guest_name"],
           "matches": _matched(m),
           "other_votes": store.q1("select count(*) n from match_votes where code=? and who=?", (code, other))["n"]}
    if not light:
        voted = {r["tmdb"] for r in store.q("select tmdb from match_votes where code=? and who=?", (code, who))}
        deck = json.loads(m["deck"])
        out |= {"deck": [d for d in deck if d["tmdb"] not in voted], "total": len(deck)}
    return out


class MatchVote(BaseModel):
    tmdb: int
    vote: Literal["like", "skip"]


@app.post("/api/match/{code}/vote")
def match_vote(body: MatchVote, request: Request, code: str = CODE):
    m = _session(code)
    who, _ = _who(request, m, claim=True)
    deck = {d["tmdb"]: d for d in json.loads(m["deck"])}
    if body.tmdb not in deck:
        raise HTTPException(400, "That movie isn't in this match.")
    store.run("insert or replace into match_votes values(?,?,?,?,?)", (code, who, body.tmdb, body.vote, time.time()))
    other = store.q1("select vote from match_votes where code=? and who=? and tmdb=?", (code, "guest" if who == "host" else "host", body.tmdb))
    return {"match": deck[body.tmdb] if body.vote == "like" and other and other["vote"] == "like" else None}


class MatchName(BaseModel):
    name: str = Field(min_length=1, max_length=40)


@app.post("/api/match/{code}/name")
def match_name(body: MatchName, request: Request, code: str = CODE):
    m = _session(code)
    who, key = _who(request, m, claim=True)
    if who == "guest":
        store.run("update match_sessions set guest_name=? where code=?", (body.name.strip(), code))
    return {"ok": True, "key": key}


@app.get("/api/match/{code}/trailer/{tmdb_id}")
def match_trailer(tmdb_id: int, code: str = CODE):
    m = _session(code)
    if tmdb_id not in {d["tmdb"] for d in json.loads(m["deck"])} or not tmdb.key():
        return {"trailer": None}
    return {"trailer": arr.safe(lambda: tmdb.extras("movie", tmdb_id)["trailer"], None)}


# ---------- Wrapped ----------
@app.get("/api/wrapped")
def get_wrapped(year: Optional[int] = None, tz: int = Query(0, ge=-840, le=840), user=Depends(current_user)):
    """Your year on NuniFlix. Only ever your own."""
    year = year or time.gmtime(time.time() + tz * 60).tm_year
    return arr.cached(f"wrapped:{user['id']}:{year}:{tz}", 3600, lambda: history.wrapped(user["id"], year, tz)) | {"name": user["name"]}


@app.get("/api/home/discover")
def home_discover(user=Depends(current_user)):
    """Home's browse rows and banner: things that aren't on the server yet (in theaters, coming soon, popular, categories)."""
    if not tmdb.key():
        return {"rows": [], "hero": None}
    have = arr.safe(media.library_movies, set())

    def new(items):  # what's already on Plex/Jellyfin lives in "Now playing"; these rows are for finding something else
        return [it for it in items if it["status"] != "available" and not (it["type"] == "movie" and it["tmdb"] in have)]
    rows = []
    for r in tmdb.home_rows():
        r["items"] = _overlay_requests(new(r["items"]))[:20]
        if len(r["items"]) >= 6:
            rows.append(r)
    pool = [x for x in new(arr.safe(tmdb.trending_quick, []))[:14] if x.get("backdrop") and x.get("overview")]
    heroes = _overlay_requests(random.sample(pool, min(6, len(pool))))  # the banner swipes through these
    return {"rows": rows, "heroes": heroes, "hero": heroes[0] if heroes else None}


@app.get("/api/home/recent")
def home_recent(kind: Literal["movie", "tv"], user=Depends(current_user)):
    return {"results": arr.safe(lambda: arr.recent(kind, 60), [])}


@app.get("/api/extra/{kind}/{tmdb_id}")
def get_extra(kind: Literal["movie", "tv"], tmdb_id: int, user=Depends(current_user)):
    """Trailer, cast, collection and 'more like this' (needs TMDB)."""
    if not tmdb.key():
        return {"trailer": None, "cast": [], "collection": None, "recommendations": []}
    d = tmdb.extras(kind, tmdb_id)
    _overlay_requests(d["recommendations"])
    if d["collection"]:
        _overlay_requests(d["collection"]["items"])
    return d


@app.get("/api/person/{pid}")
def get_person(pid: int, user=Depends(current_user)):
    d = tmdb.person(pid)
    _overlay_requests(d["credits"])
    return d


@app.get("/api/browse/providers")
def browse_providers(user=Depends(current_user)):
    if not tmdb.key():
        return {"enabled": False, "providers": [], "trending": []}
    return {"enabled": True, "providers": tmdb.providers(), "trending": _overlay_requests(tmdb.trending())}


@app.get("/api/browse/provider/{pid}")
def browse_provider(pid: str = Path(pattern=r"^\d+(\|\d+){0,4}$"), type: Literal["movie", "tv", "all"] = "movie", sort: Literal["popular", "new", "top"] = "popular",
                    page: int = 1, cat: Optional[str] = Query(None, pattern=r"^[a-z]{2,20}$"), quick: bool = False,
                    user=Depends(current_user)):
    page = max(1, min(page, 500))
    d = tmdb.discover_all(pid, sort, page, cat, resolve=not quick) if type == "all" else tmdb.discover(pid, type, sort, page, cat, resolve=not quick)
    _overlay_requests(d["results"])
    prov = next((p for p in tmdb.providers() if p["id"] == pid), None)
    return d | {"provider": prov}


@app.get("/api/browse/provider/{pid}/search")
def browse_search(q: str, pid: str = Path(pattern=r"^\d+(\|\d+){0,4}$"), type: Optional[Literal["movie", "tv"]] = None,
                  user=Depends(current_user)):
    q = q.strip()[:100]
    if len(q) < 2:
        return {"results": []}
    return {"results": _overlay_requests(tmdb.search_on(pid, q, type))}


@app.get("/api/browse/provider/{pid}/rows")
def browse_rows(pid: str = Path(pattern=r"^\d+(\|\d+){0,4}$"), type: Literal["movie", "tv", "all"] = "tv",
                cat: Optional[str] = Query(None, pattern=r"^[a-z]{2,20}$"), user=Depends(current_user)):
    """A service's home screen. type=all: movies and shows together, plus its genres (the Apple TV app);
    type=all&cat=<genre>: that genre laid out the same way; type=movie/tv: just movies or shows, with genre rows."""
    prov = next((p for p in tmdb.providers() if p["id"] == pid), None)
    name = (prov or {}).get("name", "")
    if type == "all":
        d = tmdb.rows_genre(pid, cat, name) if cat else tmdb.rows_all(pid, name)
    else:
        d = tmdb.rows(pid, type, name)
    for r in d["rows"]:
        _overlay_requests(r["items"])
    return d | {"provider": prov}


@app.get("/api/home")
def home(user=Depends(current_user)):
    # Your requests: everything still on its way, plus finished/declined ones for 3 days. The Requests tab keeps the rest.
    cutoff = time.time() - 3 * 86400
    mine = [shape_request(r) for r in _requests("r.user_id=?", (user["id"],), 40)]
    mine = [r for r in mine if r["status"] == "pending"
            or (r["status"] == "approved" and r["media_status"] != "available")
            or (r["done_at"] or r["updated"]) > cutoff][:20]
    return {
        "recent_movies": arr.safe(lambda: arr.recent("movie"), []),
        "recent_tv": arr.safe(lambda: arr.recent("tv"), []),
        "my_requests": mine,
    }


def _overlay_requests(items):
    """Mark search results someone has already asked for (pending ones aren't in Radarr/Sonarr yet)."""
    todo = [it for it in items if it["status"] in ("none", "partial")]
    if not todo and not store.config()["show_requester"]:
        return items
    latest = {}  # (type, id) -> (status, first name) of the newest open request
    for r in store.q("select r.type, r.ext_id, r.status, u.name from requests r left join users u on u.id=r.user_id "
                     "where r.is4k=0 and r.status in ('pending','approved') order by r.created"):
        latest[(r["type"], r["ext_id"])] = (r["status"], ((r["name"] or "").split() or [""])[0][:14])
    for it in todo:
        st = latest.get((it["type"], it["id"]), (None,))[0]
        if st == "pending":
            it["status"] = "pending"
        elif st and it["status"] == "none":
            it["status"] = "processing"
    if store.config()["show_requester"]:  # the owner's choice: posters say who asked for it
        for it in items:
            hit = latest.get((it["type"], it["id"]))
            if hit and hit[1] and it["status"] != "available":
                it["requested_by"] = hit[1]
    return items


# ---------- requests ----------
def _anon(r):
    """Someone else's request, for a non-admin: what's asked for and its state, not who asked or the admin's notes."""
    return r | {"requested_by": {"id": None, "name": None}, "note": None, "profile": None, "root": None}


def _by(user, name):
    return f" by {name}" if store.is_admin(user) else ""


def shape_request(r):
    is4k = bool(r.get("is4k"))
    media, progress = arr.state(r["type"], r["ext_id"], is4k) if r["status"] == "approved" else (None, None)
    return {
        "id": r["id"], "type": r["type"], "media_id": r["ext_id"], "tmdb": r["tmdb_id"],
        "title": r["title"], "year": r["year"], "poster": r["poster"],
        "seasons": json.loads(r["seasons"]) if r["seasons"] else None,
        "episodes": json.loads(r["episodes"]) if r.get("episodes") else None,
        "is4k": is4k, "profile": r.get("profile"), "root": r.get("root"),
        "status": r["status"], "done_at": r.get("done_at"), "media_status": media, "progress": progress, "note": r["note"],
        "why": arr.why(r["type"], r["ext_id"], is4k) if r["status"] == "approved" and media != "available" else None,
        "requested_by": {"id": r["user_id"], "name": r.get("user_name")},
        "created": r["created"], "updated": r["updated"],
    }


def what(r):
    """'Season 2', 'S1 E3, E4', 'Whole show' or 'Movie'."""
    seasons = json.loads(r["seasons"]) if r.get("seasons") else None
    eps = json.loads(r["episodes"]) if r.get("episodes") else None
    if eps:
        return f"S{seasons[0]} E" + ", E".join(map(str, eps)) if len(eps) <= 4 else f"{len(eps)} episodes of season {seasons[0]}"
    if seasons:
        return ("Season " if len(seasons) == 1 else "Seasons ") + ", ".join(map(str, seasons))
    return "Whole show" if r["type"] == "tv" else "Movie"


def label(r):
    """'Severance (Season 2) in 4K' for notifications."""
    w = what(r) if r["type"] == "tv" else ""
    return r["title"] + (f" ({w})" if w else "") + (" in 4K" if r.get("is4k") else "")


def req_fields(r, requester_name, *extra):
    return [("Requested by", requester_name), ("Type", ("TV · " + what(r)) if r["type"] == "tv" else "Movie"),
            ("Quality", "4K") if r.get("is4k") else ("", None), *extra]


def _requests(where="1=1", args=(), limit=100):
    return store.q("select r.*, u.name as user_name from requests r join users u on u.id=r.user_id "
                   f"where {where} order by r.created desc limit ?", (*args, limit))


@app.get("/api/requests")
def list_requests(scope: Literal["mine", "all"] = "mine", status: Optional[str] = None, user=Depends(current_user)):
    where, args = [], []
    if scope == "mine" or not store.is_admin(user):
        where.append("r.user_id=?"); args.append(user["id"])
    if status:
        where.append("r.status=?"); args.append(status)
    return {"requests": [shape_request(r) for r in _requests(" and ".join(where) or "1=1", args, 200)]}


class NewRequest(BaseModel):
    type: Literal["movie", "tv"]
    id: int
    seasons: Optional[list[int]] = None  # tv only; None = all seasons
    episodes: Optional[list[int]] = None  # tv only: just these episodes of the one season in `seasons`
    is4k: bool = False
    profile: Optional[int] = None  # admins only: quality profile and folder for this request
    root: Optional[str] = Field(None, max_length=300)


def _send(r):
    """Hand an approved request to Radarr/Sonarr. Returns (status, note)."""
    try:
        k = {"is4k": bool(r.get("is4k")), "profile": r.get("profile"), "root": r.get("root")}
        if r["type"] == "movie":
            arr.add_movie(r["ext_id"], **k)
        elif r.get("episodes"):
            arr.add_episodes(r["ext_id"], json.loads(r["seasons"])[0], json.loads(r["episodes"]), **k)
        else:
            arr.add_series(r["ext_id"], json.loads(r["seasons"]) if r["seasons"] else None, **k)
        arr.invalidate("queue:")
        return "approved", None
    except arr.ArrError as e:
        return "failed", str(e)


def quota(user, kind):
    """{limit, days, used, frees_at} for this person, or None when they have no limit."""
    if store.is_admin(user):
        return None
    p, q = store.perms(user), store.config()["quotas"]
    limit = p[kind + "_limit"] if p[kind + "_limit"] is not None else q[kind + "_limit"]
    days = p[kind + "_days"] if p[kind + "_days"] is not None else q[kind + "_days"]
    if not limit:
        return None
    rows = store.q("select created from requests where user_id=? and type=? and status!='denied' and created>? order by created",
                   (user["id"], kind, time.time() - days * 86400))
    return {"limit": limit, "days": days, "used": len(rows), "frees_at": rows[0]["created"] + days * 86400 if rows else None}


def check_allowed(user, kind, is4k):
    """Per-person permissions and request limits. Admins can do anything."""
    if store.is_admin(user):
        return
    p = store.perms(user)
    if not p["can_" + kind]:
        raise HTTPException(403, f"Your account can't request {'movies' if kind == 'movie' else 'TV shows'}. Ask the owner.")
    if is4k and not p["request_4k"]:
        raise HTTPException(403, "Your account can't request 4K. Ask the owner.")
    q = quota(user, kind)
    if q and q["used"] >= q["limit"]:
        wait = max(1, math.ceil((q["frees_at"] - time.time()) / 86400))
        what = f"{'movie' if kind == 'movie' else 'TV'} request" + ("" if q["limit"] == 1 else "s")
        raise HTTPException(429, f"You've used your {q['limit']} {what} for the last {q['days']} days. "
                                 f"Another frees up in {wait} day{'' if wait == 1 else 's'}.")


def auto_ok(user, kind):
    if store.is_admin(user):
        return True
    a = store.perms(user)["auto_" + kind]
    return store.config()["auto_approve"] if a is None else a


def _new(body, it, seasons, episodes, user):
    """Save the request, then approve it right away or let the admins know."""
    admin = store.is_admin(user)
    now = time.time()
    with store.tx():
        check_allowed(user, body.type, body.is4k)
        rid = store.run("insert into requests(type,ext_id,tmdb_id,title,year,poster,seasons,episodes,user_id,status,created,updated,"
                        "is4k,profile,root) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (body.type, body.id, it.get("tmdb"), it["title"], it["year"], it["poster"],
                         json.dumps(seasons) if seasons else None, json.dumps(episodes) if episodes else None,
                         user["id"], "pending", now, now, int(body.is4k),
                         body.profile if admin else None, (body.root or None) if admin else None))
    if auto_ok(user, body.type):
        return decide(rid, "approve", None, user)
    r = store.q1("select * from requests where id=?", (rid,))
    notify.send("pending", f"New request: {label(r)}", f"{user['name']} asked for it. Approve or decline it in NuniFlix.",
                admins=True, poster=it["poster"], channel=True, media=(body.type, body.id),
                fields=req_fields(r, user["name"], ("Status", "Waiting for approval")))
    return {"request": shape_request(_requests("r.id=?", (rid,), 1)[0])}


@app.post("/api/requests")
def create_request(body: NewRequest, user=Depends(current_user)):
    is4k = body.is4k
    if is4k and not arr.has(arr.srv_for(body.type, True)):
        raise HTTPException(400, "4K isn't set up.")
    check_allowed(user, body.type, is4k)
    it = arr.item(body.type, body.id)
    seasons = sorted(set(body.seasons)) if body.type == "tv" and body.seasons else None
    if body.type == "tv" and body.episodes:
        return _request_episodes(body, it, seasons, user)
    if seasons:
        have = {s["n"]: s for s in it["seasons"]}
        seasons = [n for n in seasons if n in have]
        if not seasons:
            raise HTTPException(400, "Pick at least one season.")
        if not is4k:  # season counts are from the regular server
            seasons = [n for n in seasons if not (have[n]["episodes"] and have[n]["have"] >= have[n]["episodes"])]
            if not seasons:
                raise HTTPException(409, "Those seasons are already in the library.")
    elif (it["status4k"] if is4k else it["status"]) == "available":
        raise HTTPException(409, "Already in the library" + (" in 4K." if is4k else "."))

    if body.type == "movie":
        open_req = store.q1("select r.*, u.name as user_name from requests r join users u on u.id=r.user_id "
                            "where r.type='movie' and r.ext_id=? and r.is4k=? and r.status in ('pending','approved') "
                            "order by r.created desc limit 1", (body.id, int(is4k)))
        if open_req:
            if open_req["status"] == "pending" and store.is_admin(user):
                return decide(open_req["id"], "approve", None, user, body.profile, body.root)
            raise HTTPException(409, f"Already requested{_by(user, open_req['user_name'])}.")
    else:
        # Seasons are independent: only seasons still waiting for approval block a new request.
        # Approved-but-missing seasons can be asked for again (that re-runs the search in Sonarr).
        pend = store.q("select r.*, u.name as user_name from requests r join users u on u.id=r.user_id "
                       "where r.type='tv' and r.ext_id=? and r.is4k=? and r.status='pending' order by r.created", (body.id, int(is4k)))
        whole = next((p for p in pend if not p["seasons"]), None)
        if whole:
            if store.is_admin(user):
                return decide(whole["id"], "approve", None, user, body.profile, body.root)
            raise HTTPException(409, f"Already requested{_by(user, whole['user_name'])}.")
        waiting = {n for p in pend if not p["episodes"] for n in json.loads(p["seasons"])}
        if seasons:
            approved = None
            if store.is_admin(user):  # an admin asking for seasons someone else is waiting on approves that request
                for p in pend:
                    ps = set(json.loads(p["seasons"]))
                    if ps <= set(seasons):
                        approved = decide(p["id"], "approve", None, user, body.profile, body.root)
                        waiting -= ps
                        seasons = [n for n in seasons if n not in ps]
            seasons = [n for n in seasons if n not in waiting]
            if not seasons:
                if approved:
                    return approved
                raise HTTPException(409, "Those seasons are already waiting for approval.")
    return _new(body, it, seasons, None, user)


def _request_episodes(body, it, seasons, user):
    if not seasons or len(seasons) != 1:
        raise HTTPException(400, "Pick episodes from one season at a time.")
    n = seasons[0]
    eps = {e["n"]: e for e in season_eps(body.id, n, it.get("tmdb"))}
    want = sorted({e for e in body.episodes if e in eps and (body.is4k or not eps[e]["have"])})
    if not want:
        raise HTTPException(409, "Those episodes are already in the library.")
    pend = store.q("select r.*, u.name as user_name from requests r join users u on u.id=r.user_id "
                   "where r.type='tv' and r.ext_id=? and r.is4k=? and r.status='pending' order by r.created", (body.id, int(body.is4k)))
    season_req = next((p for p in pend if not p["seasons"] or (n in json.loads(p["seasons"]) and not p["episodes"])), None)
    if season_req:
        if store.is_admin(user):
            return decide(season_req["id"], "approve", None, user, body.profile, body.root)
        raise HTTPException(409, f"Season {n} is already requested{_by(user, season_req['user_name'])}.")
    waiting = {e for p in pend if p["episodes"] and n in json.loads(p["seasons"]) for e in json.loads(p["episodes"])}
    want = [e for e in want if e not in waiting]
    if not want:
        raise HTTPException(409, "Those episodes are already waiting for approval.")
    return _new(body, it, [n], want, user)


def decide(rid, action, note, by, profile=None, root=None):
    r = store.q1("select * from requests where id=?", (rid,))
    if not r:
        raise HTTPException(404, "No such request.")
    if action == "approve":
        if not store.change("update requests set status='sending' where id=? and status in ('pending','failed','denied')", (rid,)):
            raise HTTPException(409, "Already approved.")
        try:
            if profile or root:  # admin picked a quality profile / folder for this one
                store.run("update requests set profile=coalesce(?,profile), root=coalesce(?,root) where id=?", (profile, root or None, rid))
                r = store.q1("select * from requests where id=?", (rid,))
            status, note = _send(r)
        except BaseException:
            store.run("update requests set status=? where id=?", (r["status"], rid))
            raise
    else:
        if not store.change("update requests set status='denied' where id=? and status='pending'", (rid,)):
            raise HTTPException(409, "Only pending requests can be declined.")
        status = "denied"
    store.run("update requests set status=?, note=?, decided_by=?, updated=? where id=?",
              (status, note, by["id"], time.time(), rid))
    requester = store.q1("select * from users where id=?", (r["user_id"],))
    if status == "approved":
        notify.send("approved", f"Approved: {label(r)}", "It's on its way.",
                    users=[requester] if r["user_id"] != by["id"] else [], poster=r["poster"], channel=True, media=(r["type"], r["ext_id"]),
                    fields=req_fields(r, requester["name"], ("Approved by", "automatically" if r["user_id"] == by["id"] else by["name"]),
                                      ("Status", "Downloading")))
    elif status == "denied":
        notify.send("denied", f"Declined: {label(r)}", note or "The owner passed on this one.", users=[requester], poster=r["poster"],
                    channel=True, media=(r["type"], r["ext_id"]), fields=req_fields(r, requester["name"], ("Declined by", by["name"]), ("Reason", note)))
    elif status == "failed":
        notify.send("failed", f"Couldn't send: {label(r)}", "", admins=True, poster=r["poster"], channel=True, media=(r["type"], r["ext_id"]),
                    fields=req_fields(r, requester["name"], ("Error", note)))
    out = shape_request(_requests("r.id=?", (rid,), 1)[0])
    if status == "failed":
        raise HTTPException(502, f"Saved, but {arr.NAMES[arr.srv_for(r['type'], bool(r['is4k']))]} said: {note}")
    return {"request": out}


class Decision(BaseModel):
    note: Optional[str] = Field(None, max_length=300)


class Override(BaseModel):
    profile: Optional[int] = None
    root: Optional[str] = Field(None, max_length=300)


@app.post("/api/requests/{rid}/approve")
def approve(rid: int, body: Optional[Override] = None, user=Depends(admin_user)):
    return decide(rid, "approve", None, user, body.profile if body else None, body.root if body else None)


@app.post("/api/requests/{rid}/deny")
def deny(rid: int, body: Decision, user=Depends(admin_user)):
    return decide(rid, "deny", body.note, user)


# ---------- telling people when things are ready ----------
PRIMED = os.path.join(store.DATA, ".watch-primed")


def check_fulfilled(silent=False):
    for r in store.q("select r.*, u.name as user_name from requests r join users u on u.id=r.user_id "
                     "where r.status='approved' and r.done_at is null"):
        seasons = json.loads(r["seasons"]) if r["seasons"] else None
        eps = json.loads(r["episodes"]) if r["episodes"] else None
        check = lambda: arr.fulfilled(r["type"], r["ext_id"], seasons, eps, bool(r["is4k"]))
        # first run: let errors through, so a server that's still starting doesn't count as "nothing ready yet"
        if not (check() if silent else arr.safe(check, False)):
            continue
        store.run("update requests set done_at=? where id=?", (time.time(), r["id"]))
        if not silent:
            notify.send("available", f"Ready to watch: {label(r)}", "It's in the library now.",
                        users=[store.q1("select * from users where id=?", (r["user_id"],))], poster=r["poster"], channel=True,
                        media=(r["type"], r["ext_id"]), fields=req_fields(r, r["user_name"], ("Status", "Available")))


LAST_ADDED = os.path.join(store.DATA, ".last-added")


def check_added():
    """Post what's new in the library (any import, requested or not) to the channel, if that event is on."""
    try:
        with open(LAST_ADDED) as f:
            last = json.load(f)
    except (FileNotFoundError, ValueError):
        last = {}
    on = store.config()["notify"]["events"].get("added")
    for kind in ("movie", "tv"):
        items = arr.safe(lambda: arr.recent(kind, 30), [])
        if not items:
            continue
        newest = max(i["added"] for i in items if i.get("added"))
        if kind in last and on:  # first look at a library just records where we are
            for it in sorted((i for i in items if (i.get("added") or "") > last[kind]), key=lambda i: i["added"])[-5:]:
                notify.send("added", f"New {'movie' if kind == 'movie' else 'episodes'}: {it['title']}", "Just added to the library.",
                            poster=it.get("poster"), channel=True, media=(kind, it["id"]))
        last[kind] = newest
    with open(LAST_ADDED, "w") as f:
        json.dump(last, f)


def check_next_seasons():
    """Finished a season? Ask for the next one on their behalf (their permissions and limits still apply)."""
    if not store.config()["auto_next"]:
        return
    since = time.time() - 2 * 86400
    for u in store.q("select * from users where blocked=0"):
        if not store.prefs(u)["auto_next"]:
            continue
        for tvdb, season, title in history.finished_seasons(u["id"], since):
            if store.q1("select 1 from auto_next where user_id=? and tvdb=? and season=?", (u["id"], tvdb, season)):
                continue
            store.run("insert into auto_next values(?,?,?,?)", (u["id"], tvdb, season, time.time()))
            try:
                r = create_request(NewRequest(type="tv", id=tvdb, seasons=[season]), u)
            except HTTPException as e:  # already there, already asked for, or not allowed for this person
                if e.status_code == 429:  # request limit used up for now: try again once it frees up
                    store.run("delete from auto_next where user_id=? and tvdb=? and season=?", (u["id"], tvdb, season))
                continue
            status = r["request"]["status"]
            notify.send("auto", f"Up next: {title} season {season}",
                        f"You finished season {season - 1}, so we asked for season {season}." +
                        (" It's on its way." if status == "approved" else " It's waiting for approval."),
                        users=[u], media=("tv", tvdb))


def _watcher():
    silent = not os.path.exists(PRIMED)  # first run ever: don't announce everything that's already there
    tick = 0
    while True:
        if tick % 8 == 0:  # every ~15 minutes
            try:
                check_next_seasons()
            except Exception as e:
                print("watcher (next season):", type(e).__name__, e, flush=True)
        if tick % 720 == 0:  # daily
            try:
                store.tidy()
            except Exception as e:
                print("watcher (tidy):", type(e).__name__, e, flush=True)
        tick += 1
        try:
            check_added()
        except Exception as e:
            print("watcher (added):", type(e).__name__, e, flush=True)
        try:
            check_fulfilled(silent)
            if silent:
                open(PRIMED, "w").close()
                silent = False
        except Exception as e:
            print("watcher:", type(e).__name__, e, flush=True)
        time.sleep(120)


@app.delete("/api/requests/{rid}")
def cancel(rid: int, user=Depends(current_user)):
    r = store.q1("select * from requests where id=?", (rid,))
    if not r:
        raise HTTPException(404, "No such request.")
    if store.is_admin(user):
        gone = store.change("delete from requests where id=? and status!='sending'", (rid,))
    else:
        gone = store.change("delete from requests where id=? and user_id=? and status='pending'", (rid, user["id"]))
    if not gone:
        raise HTTPException(403 if not store.is_admin(user) else 409, "You can only cancel your own pending requests."
                            if not store.is_admin(user) else "That request is being sent right now.")
    return {"ok": True}


# ---------- problems with what's already there ----------
class NewIssue(BaseModel):
    type: Literal["movie", "tv"]
    id: int
    kind: Literal["video", "audio", "subtitles", "other"]
    season: Optional[int] = None
    episode: Optional[int] = None
    message: str = Field("", max_length=1000)


def shape_issue(i):
    return {k: i[k] for k in ("id", "type", "title", "poster", "season", "episode", "kind", "message", "status", "reply",
                              "created", "updated")} | {"media_id": i["ext_id"], "reported_by": {"id": i["user_id"], "name": i.get("user_name")}}


@app.post("/api/issues")
def create_issue(body: NewIssue, user=Depends(current_user)):
    it = arr.item(body.type, body.id)
    now = time.time()
    iid = store.run("insert into issues(type,ext_id,title,poster,season,episode,kind,message,user_id,status,created,updated) "
                    "values(?,?,?,?,?,?,?,?,?,'open',?,?)",
                    (body.type, body.id, it["title"], it["poster"], body.season, body.episode, body.kind,
                     body.message.strip(), user["id"], now, now))
    where = f" S{body.season}" + (f" E{body.episode}" if body.episode else "") if body.season else ""
    notify.send("issue", f"Problem reported: {it['title']}{where}", body.message.strip(),
                admins=True, poster=it["poster"], channel=True, media=(body.type, body.id),
                fields=[("Reported by", user["name"]), ("Problem", body.kind.title()), ("Where", where.strip() or "Whole title")])
    return {"issue": shape_issue(store.q1("select i.*, u.name as user_name from issues i join users u on u.id=i.user_id where i.id=?", (iid,)))}


@app.get("/api/issues")
def list_issues(status: Literal["open", "resolved", "all"] = "open", user=Depends(current_user)):
    where, args = [], []
    if not store.is_admin(user):
        where.append("i.user_id=?"); args.append(user["id"])
    if status != "all":
        where.append("i.status=?"); args.append(status)
    rows = store.q("select i.*, u.name as user_name from issues i join users u on u.id=i.user_id "
                   f"where {' and '.join(where) or '1=1'} order by i.created desc limit 200", args)
    return {"issues": [shape_issue(i) for i in rows]}


class IssueChange(BaseModel):
    status: Optional[Literal["open", "resolved"]] = None
    reply: Optional[str] = Field(None, max_length=1000)


@app.post("/api/issues/{iid}")
def change_issue(iid: int, body: IssueChange, user=Depends(admin_user)):
    i = store.q1("select * from issues where id=?", (iid,))
    if not i:
        raise HTTPException(404, "No such problem report.")
    status = body.status or i["status"]
    reply = body.reply.strip() if body.reply is not None else i["reply"]
    store.run("update issues set status=?, reply=?, updated=?, resolved_by=? where id=?",
              (status, reply, time.time(), user["id"] if status == "resolved" else None, iid))
    if (status == "resolved" and i["status"] != "resolved") or (body.reply and body.reply.strip()):
        reporter = store.q1("select * from users where id=?", (i["user_id"],))
        notify.send("resolved" if status == "resolved" else "reply",
                    f"{'Fixed' if status == 'resolved' else 'Reply'}: {i['title']}",
                    reply or "The problem you reported has been fixed.", users=[reporter], poster=i["poster"],
                    channel=status == "resolved", media=(i["type"], i["ext_id"]),
                    fields=[("Reported by", reporter["name"]), ("Problem", i["kind"].title()), ("Fixed by", user["name"])])
    return {"ok": True}


@app.delete("/api/issues/{iid}")
def delete_issue(iid: int, user=Depends(current_user)):
    i = store.q1("select * from issues where id=?", (iid,))
    if not i:
        raise HTTPException(404, "No such problem report.")
    if not store.is_admin(user) and i["user_id"] != user["id"]:
        raise HTTPException(403, "That's not your report.")
    store.run("delete from issues where id=?", (iid,))
    return {"ok": True}


class Unavailable(BaseModel):
    type: Literal["movie", "tv"]
    id: int
    seasons: Optional[list[int]] = Field(None, max_length=100)  # TV: which seasons; None = all of them
    is4k: bool = False
    better: bool = True  # True: blocklist this copy and look for another; False: just take it away


@app.post("/api/admin/unavailable")
def mark_unavailable(body: Unavailable, user=Depends(admin_user)):
    """A bad copy (wrong cut, cam, broken audio): take it out so it no longer shows as ready to watch."""
    if body.type == "tv" and body.seasons is not None and not body.seasons:
        raise HTTPException(400, "Pick the seasons to take away.")
    removed = arr.unavailable(body.type, body.id, body.seasons, body.is4k, body.better)
    if body.better:  # people who asked for it hear "ready to watch" again once the new copy lands
        rows = store.q("select id, seasons from requests where type=? and ext_id=? and is4k=? and status='approved' and done_at is not null",
                       (body.type, body.id, int(body.is4k)))
        for r in rows:
            asked = json.loads(r["seasons"]) if r["seasons"] else None
            if body.seasons is None or asked is None or set(asked) & set(body.seasons):
                store.run("update requests set done_at=null where id=?", (r["id"],))
    print(f"unavailable: {user['name']} took {body.type} {body.id}{' 4K' if body.is4k else ''} "
          f"seasons={body.seasons} better={body.better} ({removed} files)", flush=True)
    return {"ok": True, "removed": removed}


@app.get("/api/admin/options/{srv}")
def admin_options(srv: Literal["radarr", "sonarr", "radarr4k", "sonarr4k"], user=Depends(admin_user)):
    """Quality profiles + folders, for picking them per request."""
    c = store.config()[srv]
    return arr.options(srv) | {"default_profile": c["profile"], "default_root": c["root"]}


# ---------- admin ----------
@app.get("/api/admin/settings")
def get_settings(user=Depends(admin_user)):
    c = store.config()
    out = {"config": store.public_config(c)}
    for kind in ("radarr", "sonarr", "radarr4k", "sonarr4k"):
        out[kind + "_options"] = arr.safe(lambda: arr.options(kind), None) if arr.has(kind) else None
    return out


class Settings(BaseModel):
    radarr: Optional[dict] = None
    sonarr: Optional[dict] = None
    radarr4k: Optional[dict] = None
    sonarr4k: Optional[dict] = None
    notify: Optional[dict] = None
    quotas: Optional[dict] = None
    jellyfin: Optional[dict] = None
    plex: Optional[dict] = None
    discord: Optional[dict] = None
    fluxer: Optional[dict] = None
    tmdb: Optional[dict] = None
    jellyfin_login: Optional[bool] = None
    plex_login: Optional[bool] = None
    discord_login: Optional[bool] = None
    fluxer_login: Optional[bool] = None
    auto_approve: Optional[bool] = None
    auto_next: Optional[bool] = None
    site_url: Optional[str] = Field(None, max_length=300)
    brand: Optional[str] = Field(None, max_length=40)
    swipe_on: Optional[bool] = None
    match_on: Optional[bool] = None
    discord_needs_link: Optional[bool] = None
    fluxer_needs_link: Optional[bool] = None
    home_off: Optional[list[str]] = Field(None, max_length=20)
    show_requester: Optional[bool] = None
    office_on: Optional[bool] = None
    office_names: Optional[bool] = None
    subtitles: Optional[dict] = None
    apns: Optional[dict] = None


EDITABLE = {"radarr": {"url", "key", "profile", "root", "availability"},
            "sonarr": {"url", "key", "profile", "root", "season_folders"},
            "jellyfin": {"url", "key", "public_url"}, "plex": {"url"}, "tmdb": {"key", "region"},
            "discord": {"client_id", "secret", "guild_id", "role_id", "bot_token"},
            "fluxer": {"url", "client_id", "secret", "guild_id", "role_id", "bot_token"},
            "radarr4k": {"url", "key", "profile", "root", "availability"},
            "sonarr4k": {"url", "key", "profile", "root", "season_folders"},
            "notify": {"webhooks", "dm", "push", "events"},
            "quotas": {"movie_limit", "movie_days", "tv_limit", "tv_days"},
            "subtitles": {"source", "key", "username", "secret", "language"},
            "apns": {"key", "key_id", "team_id", "topic"}}
FLAGS = ("jellyfin_login", "plex_login", "discord_login", "fluxer_login", "fluxer_needs_link", "auto_approve", "auto_next", "swipe_on", "match_on", "discord_needs_link", "show_requester", "office_on", "office_names")


HOOK_RE = re.compile(r"^https?://[^\s'\"<>]+/webhooks?/[^\s'\"<>]+$")


def _webhooks(new, old):
    """The settings page sends [{id?, name, url?}]: a blank url keeps that webhook's saved link."""
    if not isinstance(new, list) or len(new) > 10:
        raise HTTPException(400, "Up to 10 webhooks.")
    saved, out = {h["id"]: h for h in old}, []
    for h in new:
        if not isinstance(h, dict):
            continue
        url = str(h.get("url") or "").strip()
        hid = str(h.get("id") or "")
        if not url and hid in saved:
            url = saved[hid]["url"]
        if not url:
            continue
        if not HOOK_RE.match(url):
            raise HTTPException(400, "A webhook link should look like https://discord.com/api/webhooks/… (or your Fluxer's).")
        out.append({"id": hid if hid in saved else secrets.token_hex(4), "name": str(h.get("name") or "").strip()[:40] or store.hook_host(url), "url": url})
    return out


def apply_settings(body: Settings):
    c = store.config()
    for section, fields in EDITABLE.items():
        new = getattr(body, section)
        for f, v in (new or {}).items():
            if f not in fields or (f in store.SECRET_FIELDS and not v):  # blank secret = keep the saved one
                continue
            if section == "notify" and f == "webhooks":
                v = _webhooks(v, c["notify"]["webhooks"])
            if section == "notify" and f == "events":
                v = {k: bool(x) for k, x in (v or {}).items() if k in store.DEFAULTS["notify"]["events"]}
            if f in ("url", "public_url") and v and not re.match(r"^https?://[^\s'\"<>]+$", str(v).strip()):
                raise HTTPException(400, "Server addresses should start with http:// or https://")
            if section == "subtitles" and f == "source" and v not in ("plex", "jellyfin", "opensubtitles"):
                raise HTTPException(400, "Subtitles come from Plex, Jellyfin or OpenSubtitles.")
            if section == "subtitles" and f == "language" and not re.fullmatch(r"[a-z]{2}", str(v)):
                raise HTTPException(400, "Use a two-letter language code, like en or es.")
            if section == "quotas":
                v = max(0, min(int(v or 0), 999)) if f.endswith("_limit") else max(1, min(int(v or 7), 365))
            c[section][f] = v.strip() if isinstance(v, str) else v
    for flag in FLAGS:
        if getattr(body, flag) is not None:
            c[flag] = getattr(body, flag)
    if body.home_off is not None:
        c["home_off"] = [k for k in dict.fromkeys(body.home_off) if k in store.HOME_ROWS]
    if body.brand is not None:
        b = re.sub(r"\s+", " ", body.brand).strip()
        if b.lower().endswith("flix"):  # "MaxFlix" typed in full
            b = b[:-4].strip()
        if b and not re.fullmatch(r"[\w .&!'-]{1,16}", b):
            raise HTTPException(400, "Keep the name to 16 letters or numbers.")
        c["brand"] = b or "Nuni"
    if body.site_url is not None:
        u = body.site_url.strip().rstrip("/")
        if u and not re.match(r"^https?://[^/\s]+$", u):
            raise HTTPException(400, "The NuniFlix address should look like http://192.168.0.49:8095 or https://flix.example.com")
        c["site_url"] = u
    store.save_config(c)
    arr.invalidate()
    return c


@app.post("/api/admin/settings")
def save_settings(body: Settings, user=Depends(owner_user)):
    c = apply_settings(body)
    tests = {k: arr.test(k, c[k]["url"], c[k]["key"]) for k in ("radarr", "sonarr") if c[k]["url"] and c[k]["key"]}
    if c["tmdb"]["key"]:
        tests["tmdb"] = tmdb.test(c["tmdb"]["key"])
    if body.apns:
        tests["apns"] = apns.check()
    return {"config": store.public_config(c), "tests": {k: {"ok": ok, "message": m} for k, (ok, m) in tests.items()}}


@app.get("/api/admin/users")
def list_users(user=Depends(admin_user)):
    rows = store.q("select u.*, (select count(*) from requests r where r.user_id=u.id) as requests "
                   "from users u order by u.last_seen desc")
    return {"users": [public_user(u) | {"blocked": bool(u["blocked"]), "requests": u["requests"],
                                        "last_seen": u["last_seen"], "perms": store.perms(u)} for u in rows]}


class Merge(BaseModel):
    into: str = Field(max_length=100)


@app.post("/api/admin/users/{uid}/merge")
def merge_user(uid: str, body: Merge, user=Depends(admin_user)):
    """Two entries that are really one person (e.g. someone who signed in with Plex and later Discord)."""
    a, b = store.q1("select * from users where id=?", (uid,)), store.q1("select * from users where id=?", (body.into,))
    if not a or not b or uid == body.into:
        raise HTTPException(404, "Pick two different people.")
    if a["owner"] or b["owner"]:  # otherwise someone else's sign-in could end up opening the owner's account
        raise HTTPException(403, "The owner's accounts can only be linked by the owner, from You → Sign-in accounts.")
    store._clash(uid, body.into)
    store.merge_users(uid, body.into)
    return {"ok": True}


class UserChange(BaseModel):
    admin: Optional[bool] = None
    blocked: Optional[bool] = None
    perms: Optional[dict] = None


@app.post("/api/admin/users/{uid}")
def change_user(uid: str, body: UserChange, user=Depends(admin_user)):
    u = store.q1("select * from users where id=?", (uid,))
    if not u:
        raise HTTPException(404, "No such user.")
    if u["owner"]:
        raise HTTPException(400, "The owner account can't be changed.")
    if not user["owner"] and (body.admin is not None or u["admin"]):
        raise HTTPException(403, "Only the owner can change admins.")
    if body.admin is not None:
        store.run("update users set admin=? where id=?", (int(body.admin), uid))
    if body.perms is not None:
        p = store.perms(u)
        for k, v in body.perms.items():
            if k not in store.PERM_DEFAULTS:
                continue
            if k.endswith(("_limit", "_days")):
                p[k] = None if v in (None, "") else max(0 if k.endswith("_limit") else 1, min(int(v), 999))
            elif k.startswith("auto_"):
                p[k] = None if v is None else bool(v)
            else:
                p[k] = bool(v)
        store.run("update users set perms=? where id=?", (json.dumps(p), uid))
    if body.blocked is not None:
        store.run("update users set blocked=? where id=?", (int(body.blocked), uid))
        if body.blocked:
            store.run("delete from sessions where user_id=?", (uid,))
    return {"ok": True}


# ---------- first-run setup ----------
# Until setup is finished, the setup endpoints need the code printed in the container log
# (so whoever reaches a fresh install first can't claim it). Afterwards they're admin-only,
# which lets the owner run the wizard again from Settings.
SETUP_CODE_PATH = os.path.join(store.DATA, "setup-code")


def setup_code():
    if not os.path.exists(SETUP_CODE_PATH):
        abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        code = "".join(secrets.choice(abc) for _ in range(8))
        with open(SETUP_CODE_PATH, "w") as f:
            f.write(code[:4] + "-" + code[4:])
        os.chmod(SETUP_CODE_PATH, 0o600)
    with open(SETUP_CODE_PATH) as f:
        return f.read().strip()


def setup_needed():
    return not store.config()["setup_done"]


@app.on_event("startup")
def start_watcher():
    threading.Thread(target=_watcher, daemon=True, name="watcher").start()
    threading.Thread(target=_office_watch, daemon=True, name="office").start()


def _office_watch():
    """Keeps the Office's log going (who started watching, what finished downloading) even when nobody has it open."""
    while True:
        time.sleep(2)
        try:
            if store.config()["office_on"] and not setup_needed():
                office.refresh()
        except Exception as e:  # never let a hiccup stop the loop
            print("office:", e, flush=True)


# ---------- the Office ----------
@app.get("/api/office")
def get_office(demo: bool = False, user=Depends(current_user)):
    """The live building. Admins can ask for a made-up busy one (demo) to see every room in use."""
    if not store.config()["office_on"] and not store.is_admin(user):
        raise HTTPException(404, "The Office is closed.")
    if demo and store.is_admin(user):
        return office.demo(user)
    return office.view(user)


@app.get("/api/office/art/{aid}", include_in_schema=False)
def office_art(aid: str = Path(pattern=r"^[\w-]{6,20}$"), user=Depends(current_user)):
    try:
        hit = office.art(aid)
    except httpx.HTTPError:
        hit = None
    if not hit:
        raise HTTPException(404)
    return Response(hit[0], media_type=hit[1], headers={"Cache-Control": "private, max-age=600"})


@app.on_event("startup")
def announce_setup():
    try:  # installs from before the wizard (no setup_done saved yet) that are already connected and owned
        with open(store.CONFIG_PATH) as f:
            legacy = "setup_done" not in json.load(f)
    except FileNotFoundError:
        legacy = False
    c = store.config()
    if legacy and (c["radarr"]["key"] or c["sonarr"]["key"]) and (c["admin_jellyfin_ids"] or store.q1("select 1 from users where owner=1")):
        c["setup_done"] = True
        store.save_config(c)
    if setup_needed():
        print(f"\n  NuniFlix setup code: {setup_code()}\n  Open the web app and enter it to start setup.\n", flush=True)


_setup_misses = [0]


def setup_auth(request: Request):
    if not setup_needed():
        return owner_user(current_user(request))
    ip = client_ip(request)
    if accounts.too_many(ip):
        raise HTTPException(429, "Too many tries. Wait 15 minutes.")
    given = re.sub(r"[^A-Z0-9]", "", request.headers.get("x-setup-code", "").upper())
    if not secrets.compare_digest(given, setup_code().replace("-", "")):
        accounts.failed(ip)
        _setup_misses[0] += 1
        if _setup_misses[0] >= 30:  # lots of wrong guesses from anywhere: throw the code away and print a new one
            _setup_misses[0] = 0
            os.remove(SETUP_CODE_PATH)
            print(f"\n  Too many wrong setup codes. New NuniFlix setup code: {setup_code()}\n", flush=True)
        raise HTTPException(403, "That setup code isn't right.")
    return None


def _owners():
    return [public_user(u) for u in store.q("select * from users where owner=1 order by created")]


@app.get("/api/setup/status")
def setup_status():
    return {"needed": setup_needed(), "version": VERSION}


@app.get("/api/setup/config")
def setup_config(request: Request, who=Depends(setup_auth)):
    return {"config": store.public_config(), "owners": _owners(),
            "discord_redirect": base_url(request) + "/api/auth/discord/callback",
            "fluxer_redirect": base_url(request) + "/api/auth/fluxer/callback"}


class SetupTest(BaseModel):
    kind: Literal["radarr", "sonarr", "radarr4k", "sonarr4k", "jellyfin", "plex", "tmdb", "discord", "fluxer", "notify"]
    url: Optional[str] = Field(None, max_length=300)
    key: Optional[str] = Field(None, max_length=600)
    client_id: Optional[str] = Field(None, max_length=40)
    secret: Optional[str] = Field(None, max_length=200)
    guild_id: Optional[str] = Field(None, max_length=40)
    bot_token: Optional[str] = Field(None, max_length=200)
    webhook: Optional[str] = Field(None, max_length=300)
    hook_id: Optional[str] = Field(None, max_length=20)  # test a saved webhook without retyping its link


_probe = httpx.Client(timeout=8, headers={"Accept": "application/json"})


@app.post("/api/setup/test")
def setup_test(body: SetupTest, who=Depends(setup_auth)):
    """Try a connection before saving it. Blank secrets fall back to the saved ones."""
    saved = store.config()[body.kind]
    url = (body.url or saved.get("url", "")).strip().rstrip("/")
    if url and not re.match(r"^https?://", url):
        return {"ok": False, "message": "The address should start with http:// or https://"}
    # a saved key only ever goes to the saved address (never to a new one someone just typed)
    same = url == (saved.get("url") or "").strip().rstrip("/") and (body.kind not in ("discord", "fluxer") or not body.client_id or body.client_id == saved.get("client_id"))
    pick = lambda f: (getattr(body, f) or "").strip() or (saved.get(f, "") if same or f not in store.SECRET_FIELDS else "")
    if body.kind == "notify":
        hook = (body.webhook or "").strip() or next((h["url"] for h in saved["webhooks"] if h["id"] == body.hook_id), "")
        if not HOOK_RE.match(hook):
            return {"ok": False, "message": "That doesn't look like a webhook link"}
        try:
            ok = notify.webhook(hook, "test", f"{store.app_name()} is connected", "Requests, ready-to-watch notes and problem reports will show up here.")
        except httpx.HTTPError:
            ok = False
        return {"ok": ok, "message": "Sent a test message to the channel" if ok else "That webhook didn't accept the message"}
    if body.kind in ("radarr", "sonarr", "radarr4k", "sonarr4k"):
        ok, msg = arr.test(body.kind, url, pick("key"))
        opts = arr.safe(lambda: arr.options(body.kind, {"url": url, "key": pick("key")}), None) if ok else None
        return {"ok": ok, "message": msg, "options": opts}
    if body.kind == "tmdb":
        ok, msg = tmdb.test(pick("key"))
        return {"ok": ok, "message": msg}
    if body.kind == "discord":
        ok, msg, roles = accounts.discord_test(pick("client_id"), pick("secret"), pick("guild_id"), pick("bot_token"))
        return {"ok": ok, "message": msg, "roles": roles}
    if body.kind == "fluxer":
        ok, msg, servers, roles = accounts.fluxer_test(url, pick("client_id"), pick("secret"), pick("guild_id"), pick("bot_token"))
        return {"ok": ok, "message": msg, "servers": servers, "roles": roles}
    try:
        if body.kind == "plex":
            r = _probe.get(url + "/identity")
            v = r.json()["MediaContainer"]["version"]
            return {"ok": True, "message": f"Plex Media Server {v.split('-')[0]}"}
        r = _probe.get(url + "/System/Info/Public")
        info = r.json()
        msg = f"{info.get('ServerName', 'Jellyfin')} · Jellyfin {info.get('Version', '')}".strip()
        if pick("key"):
            k = _probe.get(url + "/System/Info", headers={"Authorization": f'MediaBrowser Token="{pick("key")}"'})
            if k.status_code != 200:
                return {"ok": False, "message": "Server found, but that API key is wrong"}
        return {"ok": True, "message": msg}
    except (httpx.HTTPError, ValueError, KeyError):
        return {"ok": False, "message": f"No {'Plex' if body.kind == 'plex' else 'Jellyfin'} server answered at that address"}


@app.post("/api/setup/save")
def setup_save(body: Settings, who=Depends(setup_auth)):
    return {"config": store.public_config(apply_settings(body))}


@app.post("/api/setup/owner/jellyfin")
def setup_owner_jellyfin(body: JellyfinLogin, request: Request, who=Depends(setup_auth)):
    ip = client_ip(request)
    if accounts.too_many(ip):
        raise HTTPException(429, "Too many tries. Wait 15 minutes.")
    c = store.config()
    if not c["jellyfin"]["url"]:
        raise HTTPException(400, "Set up Jellyfin first.")
    jf = accounts.jellyfin_auth(c["jellyfin"]["url"], body.username.strip(), body.password, body.device or "Web")
    if not jf:
        accounts.failed(ip)
        raise HTTPException(401, "Wrong username or password.")
    if not (jf.get("Policy") or {}).get("IsAdministrator"):
        raise HTTPException(403, "That account isn't an administrator on your Jellyfin. Use the one that runs the server.")
    if jf["Id"] not in c["admin_jellyfin_ids"]:
        c["admin_jellyfin_ids"].append(jf["Id"])
        store.save_config(c)
    user = store.login_identity({"id": "jf:" + jf["Id"], "name": jf.get("Name", body.username), "source": "jellyfin", "owner": True})
    return signed_in(request, user, body.device or "Web", "jf:" + jf["Id"])


@app.post("/api/setup/owner/plex/start")
def setup_owner_plex_start(who=Depends(setup_auth)):
    return accounts.plex_start()


@app.post("/api/setup/owner/plex/check")
def setup_owner_plex_check(body: PlexCheck, request: Request, who=Depends(setup_auth)):
    ident = accounts.plex_check(body.state)
    if not ident:
        return JSONResponse({"pending": True}, status_code=202)
    if not ident["owner"]:
        raise HTTPException(403, "That Plex account doesn't own your Plex server. Sign in with the one that does.")
    return signed_in(request, store.login_identity(ident), body.device or "Web", ident["id"])


@app.post("/api/setup/finish")
def setup_finish(who=Depends(setup_auth)):
    c = store.config()
    if not store.q1("select 1 from users where owner=1"):
        raise HTTPException(400, "Sign in with your own Plex or Jellyfin account first, so there's an admin.")
    if not (c["radarr"]["key"] or c["sonarr"]["key"]):
        raise HTTPException(400, "Connect Radarr or Sonarr first, so requests have somewhere to go.")
    c["setup_done"] = True
    store.save_config(c)
    if os.path.exists(SETUP_CODE_PATH):
        os.remove(SETUP_CODE_PATH)
    return {"ok": True}


# ---------- web app ----------
@app.middleware("http")
async def fresh_app(request: Request, call_next):
    """Phones (especially home-screen apps) hold on to old copies of the page; make them check for a new one."""
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/office/"):  # the Office's pictures: every link carries ?v=, so they can be kept for good
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif not path.startswith("/api/") and path.endswith(("/", ".html", ".js", ".webmanifest")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp



app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "web"), html=True), name="web")
