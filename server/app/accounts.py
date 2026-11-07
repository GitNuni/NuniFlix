"""Sign in with Jellyfin (username/password checked by Jellyfin) or Plex (plex.tv PIN, polled).

Discord sign-in is OAuth: people must be in the configured Discord server and (if set) have its role.

No passwords are stored here. Who is an admin ("owner"):
  - the Plex account that owns the Plex server
  - Jellyfin accounts whose id is listed in config admin_jellyfin_ids
Being a Jellyfin admin, a Plex friend or anyone on Discord does NOT make someone a NuniFlix admin.
"""
import os, secrets, threading, time, urllib.parse

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
    user = jellyfin_auth(cfg["jellyfin"]["url"], username, password, device)
    if not user:
        return None
    return {"id": "jf:" + user["Id"], "name": user.get("Name", username), "source": "jellyfin",
            "owner": user["Id"] in cfg["admin_jellyfin_ids"]}


def jellyfin_auth(url, username, password, device="Web"):
    """Jellyfin's own record for this user if the password is right (and the account is enabled), else None."""
    auth = f'MediaBrowser Client="{store.app_name()}", Device="{device[:40]}", DeviceId="nuniflix-{secrets.token_hex(6)}", Version="1.0"'
    try:
        r = _http.post(url.rstrip("/") + "/Users/AuthenticateByName",
                       headers={"Authorization": auth}, json={"Username": username, "Pw": password})
    except httpx.HTTPError:
        raise LoginError("Jellyfin isn't reachable right now.")
    if r.status_code != 200:
        return None
    d = r.json()
    user, token = d.get("User") or {}, d.get("AccessToken")
    if token:  # don't leave a device session behind in Jellyfin
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
            "source": "plex", "owner": bool(mine.get("owned"))}


def _plex_server_id():
    url = store.config()["plex"]["url"]
    if not url:
        raise LoginError("Plex isn't set up yet.")
    try:
        r = _http.get(url.rstrip("/") + "/identity", headers={"Accept": "application/json"})
        return r.json()["MediaContainer"]["machineIdentifier"]
    except Exception:
        raise LoginError("Couldn't reach your Plex server.")


# ---------- Discord ----------
# Works like Plex: the app opens Discord in a window and polls with a secret `state`.
# The callback finishes the sign-in and parks the result here until the app picks it up.
_discord, _discord_lock = {}, threading.Lock()  # state: {"t", "redirect", "user"?, "error"?}


def discord_ready(cfg=None):
    cfg = cfg or store.config()
    d = cfg["discord"]
    return bool(cfg["discord_login"] and d["client_id"] and d["secret"] and d["guild_id"])


def discord_start(redirect_uri):
    cfg = store.config()
    if not discord_ready(cfg):
        raise LoginError("Discord sign-in is turned off.")
    state = secrets.token_urlsafe(24)
    with _discord_lock:
        now = time.time()
        for k in [k for k, v in _discord.items() if now - v["t"] > 900]:
            del _discord[k]
        if len(_discord) >= MAX_PENDING:
            raise LoginError("Too many sign-ins in progress. Try again in a few minutes.")
        _discord[state] = {"t": now, "redirect": redirect_uri}
    params = {"client_id": cfg["discord"]["client_id"], "response_type": "code", "redirect_uri": redirect_uri,
              "scope": "identify guilds.members.read", "state": state, "prompt": "none"}
    return {"state": state, "url": "https://discord.com/oauth2/authorize?" + urllib.parse.urlencode(params)}


def discord_callback(state, code, error=None):
    """Runs in the Discord window. Returns a message to show there."""
    with _discord_lock:
        entry = _discord.get(state)
    if not entry or "ident" in entry or "error" in entry:
        return f"That sign-in link expired. Go back to {store.app_name()} and try again."
    try:
        if error or not code:
            raise LoginError("Discord sign-in was cancelled.")
        entry["ident"] = _discord_finish(code, entry["redirect"])
        return f"You're signed in. You can close this window and go back to {store.app_name()}."
    except LoginError as e:
        entry["error"] = str(e)
        return str(e)


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


def discord_check(state):
    """None while the person is still on Discord; their identity once they're through."""
    with _discord_lock:
        entry = _discord.get(state)
        if entry and ("ident" in entry or "error" in entry):
            del _discord[state]
    if not entry:
        raise LoginError("That Discord sign-in expired. Start again.")
    if "error" in entry:
        raise LoginError(entry["error"])
    return entry.get("ident")


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
