"""Sign in with Jellyfin (username/password checked by Jellyfin) or Plex (plex.tv PIN, polled).

Discord and Fluxer sign-in are OAuth: people must be in the configured Discord/Fluxer server and (if set) have its role.

No passwords are stored here. Each person's own Plex/Jellyfin token for the owner's server is kept (store.media_tokens)
so the in-app player can stream as them: their libraries, their watch history, their resume points. Who is an admin ("owner"):
  - the Plex account that owns the Plex server
  - Jellyfin accounts whose id is listed in config admin_jellyfin_ids
Being a Jellyfin admin, a Plex friend or anyone on Discord does NOT make someone a NuniFlix admin.
"""
import hashlib, os, secrets, threading, time, urllib.parse

import httpx

import store

PLEX_TV = "https://plex.tv/api/v2"
DISCORD = "https://discord.com/api/v10"
_http = httpx.Client(timeout=10)


class LoginError(Exception):
    pass


# ---------- Jellyfin ----------
def jellyfin_identity(username, password, device="Web"):
    cfg = store.config()
    if not cfg["jellyfin_login"] or not cfg["jellyfin"]["url"]:
        raise LoginError("Jellyfin sign-in is turned off.")
    user = jellyfin_auth(cfg["jellyfin"]["url"], username, password, device, keep=True)
    if not user:
        return None
    return {"id": "jf:" + user["Id"], "name": user.get("Name", username), "source": "jellyfin",
            "owner": user["Id"] in cfg["admin_jellyfin_ids"], "media_token": user.get("_token")}


def jellyfin_auth(url, username, password, device="Web", keep=False):
    """Jellyfin's own record for this user if the password is right (and the account is enabled), else None.
    keep=True: leave the Jellyfin session open and put its token in user["_token"] (for playing in the app). It uses one
    device id per username, so signing in again replaces the old session instead of piling them up in Jellyfin."""
    dev_id = "nuniflix-" + (hashlib.sha256(username.lower().encode()).hexdigest()[:12] if keep else secrets.token_hex(6))
    auth = f'MediaBrowser Client="{store.app_name()}", Device="{device[:40]}", DeviceId="{dev_id}", Version="1.0"'
    try:
        r = _http.post(url.rstrip("/") + "/Users/AuthenticateByName",
                       headers={"Authorization": auth}, json={"Username": username, "Pw": password})
    except httpx.HTTPError:
        raise LoginError("Jellyfin isn't reachable right now.")
    if r.status_code != 200:
        return None
    d = r.json()
    user, token = d.get("User") or {}, d.get("AccessToken")
    if token and keep:
        user["_token"] = token
    elif token:  # don't leave a device session behind in Jellyfin
        try:
            _http.post(url.rstrip("/") + "/Sessions/Logout", headers={"Authorization": f'{auth}, Token="{token}"'})
        except httpx.HTTPError:
            pass
    if not user.get("Id") or (user.get("Policy") or {}).get("IsDisabled"):
        return None
    return user


# ---------- Plex ----------
def _client_id():
    path = os.path.join(store.DATA, "plex-client-id")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write("nuniflix-" + secrets.token_hex(12))
    with open(path) as f:
        return f.read().strip()


def _plex_headers(token=None):
    h = {"Accept": "application/json", "X-Plex-Product": store.app_name(), "X-Plex-Client-Identifier": _client_id()}
    if token:
        h["X-Plex-Token"] = token
    return h


# pin state lives in memory: {state: (pin_id, created)}. The state secret ties a PIN to whoever started it,
# so nobody can finish someone else's sign-in by guessing PIN ids.
_pins, _pins_lock = {}, threading.Lock()
MAX_PENDING = 500  # sign-ins in progress at once (anyone can start one, so it's capped)


def plex_start():
    if not store.config()["plex_login"]:
        raise LoginError("Plex sign-in is turned off.")
    try:
        r = _http.post(f"{PLEX_TV}/pins", params={"strong": "true"}, headers=_plex_headers())
        r.raise_for_status()
    except httpx.HTTPError:
        raise LoginError("Plex didn't respond. Try again in a moment.")
    pin = r.json()
    state = secrets.token_urlsafe(24)
    with _pins_lock:
        now = time.time()
        for k in [k for k, (_, t) in _pins.items() if now - t > 900]:
            del _pins[k]
        if len(_pins) >= MAX_PENDING:
            raise LoginError("Too many sign-ins in progress. Try again in a few minutes.")
        _pins[state] = (pin["id"], now)
    params = {"clientID": _client_id(), "code": pin["code"], "context[device][product]": store.app_name()}
    return {"state": state, "url": "https://app.plex.tv/auth#?" + urllib.parse.urlencode(params)}


def plex_check(state):
    """None while the user hasn't finished on plex.tv; their identity {id, name, source, owner} once they have."""
    with _pins_lock:
        entry = _pins.get(state)
    if not entry:
        raise LoginError("That Plex sign-in expired. Start again.")
    try:
        r = _http.get(f"{PLEX_TV}/pins/{entry[0]}", headers=_plex_headers())
    except httpx.HTTPError:
        raise LoginError("Plex didn't respond.")
    token = r.json().get("authToken") if r.status_code == 200 else None
    if not token:
        return None
    with _pins_lock:
        _pins.pop(state, None)
    me = _http.get(f"{PLEX_TV}/user", headers=_plex_headers(token))
    if me.status_code != 200:
        raise LoginError("Plex didn't accept that sign-in.")
    me = me.json()
    server = _plex_server_id()
    res = _http.get(f"{PLEX_TV}/resources", headers=_plex_headers(token))
    mine = next((x for x in (res.json() if res.status_code == 200 else []) if x.get("clientIdentifier") == server), None)
    if not mine:
        raise LoginError("That Plex account doesn't have access to this server.")
    if mine.get("owned") and mine.get("accessToken"):  # lets NuniFlix find titles on the server for "Play on Plex"
        cfg = store.config()
        if cfg["plex"].get("token") != mine["accessToken"]:
            cfg["plex"]["token"] = mine["accessToken"]
            store.save_config(cfg)
    return {"id": f"plex:{me.get('id')}", "name": me.get("username") or me.get("title") or "plex user",
            "source": "plex", "owner": bool(mine.get("owned")), "media_token": mine.get("accessToken")}


def _plex_server_id():
    url = store.config()["plex"]["url"]
    if not url:
        raise LoginError("Plex isn't set up yet.")
    try:
        r = _http.get(url.rstrip("/") + "/identity", headers={"Accept": "application/json"})
        return r.json()["MediaContainer"]["machineIdentifier"]
    except Exception:
        raise LoginError("Couldn't reach your Plex server.")


# ---------- Discord and Fluxer ----------
# Both work like Plex: the app opens Discord/Fluxer in a window and polls with a secret `state`.
# The callback finishes the sign-in and parks the result here until the app picks it up.
_oauth, _oauth_lock = {}, threading.Lock()  # state: {"t", "kind", "redirect", "ident"?, "error"?}
OAUTH_NAMES = {"discord": "Discord", "fluxer": "Fluxer"}


def _new_state(kind, redirect_uri):
    state = secrets.token_urlsafe(24)
    with _oauth_lock:
        now = time.time()
        for k in [k for k, v in _oauth.items() if now - v["t"] > 900]:
            del _oauth[k]
        if len(_oauth) >= MAX_PENDING:
            raise LoginError("Too many sign-ins in progress. Try again in a few minutes.")
        _oauth[state] = {"t": now, "kind": kind, "redirect": redirect_uri}
    return state


def oauth_callback(kind, state, code, error=None):
    """Runs in the Discord/Fluxer window. Returns a message to show there."""
    with _oauth_lock:
        entry = _oauth.get(state)
    if not entry or entry["kind"] != kind or "ident" in entry or "error" in entry:
        return f"That sign-in link expired. Go back to {store.app_name()} and try again."
    try:
        if error or not code:
            raise LoginError(f"{OAUTH_NAMES[kind]} sign-in was cancelled.")
        entry["ident"] = (_discord_finish if kind == "discord" else _fluxer_finish)(code, entry["redirect"])
        return f"You're signed in. You can close this window and go back to {store.app_name()}."
    except LoginError as e:
        entry["error"] = str(e)
        return str(e)


def oauth_check(kind, state):
    """None while the person is still on Discord/Fluxer; their identity once they're through."""
    with _oauth_lock:
        entry = _oauth.get(state)
        if entry and entry["kind"] != kind:
            entry = None
        if entry and ("ident" in entry or "error" in entry):
            del _oauth[state]
    if not entry:
        raise LoginError(f"That {OAUTH_NAMES[kind]} sign-in expired. Start again.")
    if "error" in entry:
        raise LoginError(entry["error"])
    return entry.get("ident")


def discord_ready(cfg=None):
    cfg = cfg or store.config()
    d = cfg["discord"]
    return bool(cfg["discord_login"] and d["client_id"] and d["secret"] and d["guild_id"])


def discord_start(redirect_uri):
    cfg = store.config()
    if not discord_ready(cfg):
        raise LoginError("Discord sign-in is turned off.")
    state = _new_state("discord", redirect_uri)
    params = {"client_id": cfg["discord"]["client_id"], "response_type": "code", "redirect_uri": redirect_uri,
              "scope": "identify guilds.members.read", "state": state, "prompt": "none"}
    return {"state": state, "url": "https://discord.com/oauth2/authorize?" + urllib.parse.urlencode(params)}


def discord_callback(state, code, error=None):
    return oauth_callback("discord", state, code, error)


def discord_check(state):
    return oauth_check("discord", state)


def _discord_finish(code, redirect_uri):
    d = store.config()["discord"]
    try:
        r = _http.post(f"{DISCORD}/oauth2/token", auth=(d["client_id"], d["secret"]),
                       data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri})
        if r.status_code != 200:
            raise LoginError("Discord didn't accept that sign-in.")
        token = r.json()["access_token"]
        h = {"Authorization": "Bearer " + token}
        me = _http.get(f"{DISCORD}/users/@me", headers=h)
        member = _http.get(f"{DISCORD}/users/@me/guilds/{d['guild_id']}/member", headers=h)
        try:  # we only needed it for these two lookups
            _http.post(f"{DISCORD}/oauth2/token/revoke", auth=(d["client_id"], d["secret"]), data={"token": token})
        except httpx.HTTPError:
            pass
    except httpx.HTTPError:
        raise LoginError("Discord didn't respond. Try again in a moment.")
    if me.status_code != 200:
        raise LoginError("Discord didn't accept that sign-in.")
    if member.status_code != 200:
        raise LoginError("You need to be in the Discord server to use this.")
    if d["role_id"] and d["role_id"] not in member.json().get("roles", []):
        raise LoginError(f"Your Discord account doesn't have the role needed for {store.app_name()}.")
    me = me.json()
    return {"id": "dc:" + me["id"], "name": me.get("global_name") or me.get("username") or "discord user", "source": "discord", "owner": False}


def discord_test(client_id, secret, guild_id, bot_token):
    """(ok, message, roles or None). Roles come back only when a bot token is given."""
    try:
        r = _http.post(f"{DISCORD}/oauth2/token", auth=(client_id, secret),
                       data={"grant_type": "client_credentials", "scope": "identify"})
        if r.status_code != 200:
            return False, "Client ID or secret is wrong", None
        if not bot_token:
            return True, "App connected", None
        h = {"Authorization": "Bot " + bot_token}
        g = _http.get(f"{DISCORD}/guilds/{guild_id}", headers=h)
        if g.status_code != 200:
            return False, "The bot can't see that server. Invite it there and check the server ID.", None
        roles = _http.get(f"{DISCORD}/guilds/{guild_id}/roles", headers=h).json()
    except httpx.HTTPError:
        return False, "Discord isn't reachable", None
    roles = [{"id": x["id"], "name": x["name"]} for x in sorted(roles, key=lambda x: -x.get("position", 0))
             if x.get("name") != "@everyone" and not x.get("managed")]
    return True, f"Connected to {g.json().get('name', 'your server')}", roles


# ---------- Fluxer ----------
# Fluxer's OAuth only hands out "identify" (who you are). Being in the server and having the role is checked with
# the bot's token (e.g. NuniBot), since a person's own Fluxer token isn't allowed to read server members.
def _fx_api(cfg_fx):
    return cfg_fx["url"].rstrip("/") + "/api/v1"


def fluxer_ready(cfg=None):
    cfg = cfg or store.config()
    f = cfg["fluxer"]
    return bool(cfg["fluxer_login"] and f["url"] and f["client_id"] and f["secret"] and f["guild_id"] and f["bot_token"])


def fluxer_start(redirect_uri):
    cfg = store.config()
    if not fluxer_ready(cfg):
        raise LoginError("Fluxer sign-in is turned off.")
    state = _new_state("fluxer", redirect_uri)
    params = {"client_id": cfg["fluxer"]["client_id"], "response_type": "code", "redirect_uri": redirect_uri,
              "scope": "identify", "state": state}
    return {"state": state, "url": cfg["fluxer"]["url"].rstrip("/") + "/oauth2/authorize?" + urllib.parse.urlencode(params)}


def _fluxer_finish(code, redirect_uri):
    f = store.config()["fluxer"]
    api = _fx_api(f)
    try:
        r = _http.post(f"{api}/oauth2/token", auth=(f["client_id"], f["secret"]),
                       data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri})
        if r.status_code != 200:
            raise LoginError("Fluxer didn't accept that sign-in.")
        token = r.json()["access_token"]
        me = _http.get(f"{api}/oauth2/userinfo", headers={"Authorization": "Bearer " + token})
        try:  # we only needed it for that one lookup
            _http.post(f"{api}/oauth2/token/revoke", auth=(f["client_id"], f["secret"]), data={"token": token})
        except httpx.HTTPError:
            pass
        if me.status_code != 200:
            raise LoginError("Fluxer didn't accept that sign-in.")
        me = me.json()
        member = _http.get(f"{api}/guilds/{f['guild_id']}/members/{me['id']}", headers={"Authorization": "Bot " + f["bot_token"]})
    except httpx.HTTPError:
        raise LoginError("Fluxer didn't respond. Try again in a moment.")
    except (ValueError, KeyError):
        raise LoginError("Fluxer sent back something unexpected. Try again.")
    if member.status_code in (401, 403):
        raise LoginError(f"{store.app_name()} can't check the Fluxer server right now (the bot isn't allowed in). Tell the owner.")
    if member.status_code != 200:
        raise LoginError("You need to be in the Fluxer server to use this.")
    if f["role_id"] and f["role_id"] not in member.json().get("roles", []):
        raise LoginError(f"Your Fluxer account doesn't have the role needed for {store.app_name()}.")
    return {"id": "fx:" + str(me["id"]), "name": me.get("global_name") or me.get("username") or "fluxer user",
            "source": "fluxer", "owner": False}


def fluxer_callback(state, code, error=None):
    return oauth_callback("fluxer", state, code, error)


def fluxer_check(state):
    return oauth_check("fluxer", state)


def fluxer_test(url, client_id, secret, guild_id, bot_token):
    """(ok, message, servers, roles). Servers = the ones the bot is in; roles = that server's, once one is picked."""
    if not url:
        return False, "Fill in your Fluxer address", None, None
    if not bot_token:
        return False, "The bot token is needed: it's how the server and role get checked", None, None
    api = url.rstrip("/") + "/api/v1"
    h = {"Authorization": "Bot " + bot_token}
    try:
        bot = _http.get(f"{api}/users/@me", headers=h)
        if bot.status_code in (401, 403):
            return False, "That bot token is wrong", None, None
        if bot.status_code != 200:
            return False, "No Fluxer answered at that address", None, None
        bot_name = bot.json().get("username") or "The bot"
        if client_id and secret:  # a wrong ID or secret fails before the made-up token is even looked at
            r = _http.post(f"{api}/oauth2/introspect", auth=(client_id, secret), data={"token": "nuniflix-check"})
            if r.status_code != 200:
                return False, "Client ID or secret is wrong", None, None
        elif not client_id:
            return False, "Fill in the app's client ID", None, None
        gl = _http.get(f"{api}/users/@me/guilds", headers=h)
        servers = [{"id": str(g["id"]), "name": g.get("name") or str(g["id"])} for g in gl.json()] if gl.status_code == 200 else None
        if not guild_id:
            if servers == []:
                return False, f"{bot_name} isn't in any Fluxer server yet", servers, None
            return True, f"{bot_name} is connected. Pick the server.", servers, None
        rl = _http.get(f"{api}/guilds/{guild_id}/roles", headers=h)
        if rl.status_code != 200:
            return False, f"{bot_name} can't see that server. Add it there and check the server.", servers, None
        roles = rl.json()
    except httpx.HTTPError:
        return False, "Fluxer isn't reachable", None, None
    except (ValueError, KeyError, TypeError):
        return False, "That doesn't look like a Fluxer server", None, None
    roles = [{"id": str(x["id"]), "name": x["name"]} for x in sorted(roles, key=lambda x: -x.get("position", 0))
             if x.get("name") != "@everyone" and str(x["id"]) != str(guild_id) and not x.get("managed")]
    name = next((g["name"] for g in servers or [] if g["id"] == str(guild_id)), "your server")
    return True, f"{bot_name} is connected to {name}", servers, roles


# ---------- brute-force guard for the password form ----------
_fails, _fails_lock = {}, threading.Lock()


def too_many(ip):
    with _fails_lock:
        now = time.time()
        if len(_fails) > 5000:  # forget addresses that stopped trying
            for k in [k for k, v in _fails.items() if not v or now - v[-1] > 900]:
                del _fails[k]
        recent = [t for t in _fails.get(ip, []) if now - t < 900]
        _fails[ip] = recent
        return len(recent) >= 8


def failed(ip):
    with _fails_lock:
        _fails.setdefault(ip, []).append(time.time())
