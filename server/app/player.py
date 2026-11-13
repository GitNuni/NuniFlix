"""Watch in the app: find a title on the person's own Plex / Jellyfin, start an HLS stream as them, and pass it
through NuniFlix.

Why as them: they only see libraries the owner shares with them, and their watch history, resume points and "who's
watching" (the Office) stay theirs. Their token comes from signing in (store.media_tokens).

Why through NuniFlix: it works wherever NuniFlix is reachable (Plex/Jellyfin are often LAN-only addresses), and their
Plex/Jellyfin token never reaches the device. The player can't add our sign-in header to every video segment, so a
stream is addressed by an unguessable id in its URL instead. Each stream may only reach that one transcode, never
the rest of the Plex/Jellyfin API. Streams end when the player says it stopped, or after STREAM_IDLE unused.
"""
import hashlib, re, secrets, threading, time, urllib.parse

import httpx

import accounts, arr, media, store

STREAM_IDLE = 3 * 3600
MAX_STREAMS = 4  # per person; starting another ends their oldest
_http = httpx.Client(timeout=15, headers={"Accept": "application/json"})
_pipe = httpx.Client(timeout=httpx.Timeout(90, connect=10))  # segments can take a while while the transcoder catches up
_streams, _lock = {}, threading.Lock()
TOKEN_PARAMS = re.compile(r"([?&])(api_key|X-Plex-Token)=[^&\s\"]*&?", re.I)


class PlayError(Exception):
    pass


# ---------- whose access ----------
def _access(user):
    """(source, token, identity) for the person's own Plex or Jellyfin account, Plex first."""
    cfg = store.config()
    stale = None
    for src, configured in (("plex", cfg["plex"]["url"]), ("jellyfin", cfg["jellyfin"]["url"] and cfg["jellyfin"]["key"])):
        if not configured:
            continue
        row = store.media_account(user["id"], src)
        if not row:
            continue
        token = row["token"] or (cfg["plex"].get("token") if src == "plex" and row["owner"] else None)
        if not token and src == "plex":
            token = plex_friend_token(row["id"])  # signed in before tokens were kept, or with Discord: ask Plex for it
        if token:
            return src, token, row["id"]
        stale = stale or store.SOURCES[src]
    if stale == "Plex":
        raise PlayError("Your Plex account doesn't seem to have access to this server's libraries. Ask the owner to share them with you in Plex.")
    if stale:
        raise PlayError(f"Sign out of {store.app_name()} and sign back in with {stale} once, so it can play things as you.")
    raise PlayError("Link your Plex or Jellyfin account (Settings → Accounts) to watch in the app.")


# ---------- someone's own Plex token, without them signing in again ----------
PLEX_COM = "https://plex.tv"


def plex_friend_token(identity_id):
    """The person's own access token for the owner's server, looked up with the owner's Plex account:
    friends the server is shared with (plex.tv shared_servers), then Plex Home members (switching to them).
    Saved like a sign-in token, so it's only looked up once. None if Plex doesn't know them."""
    import xml.etree.ElementTree as ET
    owner = store.config()["plex"].get("token")
    uid = identity_id.split(":", 1)[1] if ":" in identity_id else ""
    if not (owner and uid):
        return None
    try:
        machine = arr.cached("plex:machine", 86400, lambda: _http.get(_plex_base() + "/identity").json()["MediaContainer"]["machineIdentifier"])
        shared = arr.cached(f"plex:shared:{machine}", 300, lambda: _http.get(
            f"{PLEX_COM}/api/servers/{machine}/shared_servers", headers={"X-Plex-Token": owner, "Accept": "application/xml"}).text)
        for el in ET.fromstring(shared).iter("SharedServer"):
            if el.get("userID") == uid and el.get("accessToken"):
                return _keep(identity_id, el.get("accessToken"))
        home = arr.cached("plex:home", 300, lambda: _http.get(
            f"{PLEX_COM}/api/home/users", headers={"X-Plex-Token": owner, "Accept": "application/xml"}).text)
        member = next((el for el in ET.fromstring(home).iter("User") if el.get("id") == uid), None)
        if member is None:
            return None
        sw = _http.post(f"{PLEX_COM}/api/home/users/{uid}/switch", headers={"X-Plex-Token": owner, "Accept": "application/xml",
                                                                          "X-Plex-Client-Identifier": accounts._client_id()})
        if sw.status_code != 201 and sw.status_code != 200:
            return None  # e.g. a Home member with a PIN
        user_token = ET.fromstring(sw.text).get("authenticationToken") or ET.fromstring(sw.text).get("authToken")
        res = _http.get(f"{accounts.PLEX_TV}/resources", headers=accounts._plex_headers(user_token)).json()
        mine = next((r for r in res if r.get("clientIdentifier") == machine), None)
        return _keep(identity_id, mine["accessToken"]) if mine and mine.get("accessToken") else None
    except (httpx.HTTPError, ValueError, KeyError, ET.ParseError, TypeError):
        return None


def _keep(identity_id, token):
    store.run("insert or replace into media_tokens values(?,?,?)", (identity_id, token, time.time()))
    return token


def _client_id(user, platform):
    """One stable player id per person and device type, so Plex/Jellyfin list it as one player."""
    return "nuniflix-" + hashlib.sha1(f"{user['id']}:{platform}".encode()).hexdigest()[:16]


def _device(platform):
    return {"tvos": "Apple TV", "ios": "iPhone", "web": "Browser"}.get(platform, "iPhone")


def _plex_base():
    return store.config()["plex"]["url"].rstrip("/")


def _jf_base():
    return store.config()["jellyfin"]["url"].rstrip("/")


def _plex_h(token, client=None, platform="ios"):
    h = accounts._plex_headers(token)
    if client:
        h.update({"X-Plex-Client-Identifier": client, "X-Plex-Platform": "iOS", "X-Plex-Device": _device(platform),
                  "X-Plex-Device-Name": f"{store.app_name()} ({_device(platform)})"})
    return h


def _jf_h(token, client="nuniflix", platform="ios"):
    return {"Accept": "application/json", "Authorization": f'MediaBrowser Client="{store.app_name()}", Device="{_device(platform)}", '
                                                         f'DeviceId="{client}", Version="1.0", Token="{token}"'}


# ---------- what can be played ----------
def options(user, kind, ext_id):
    """{source, items: [{id, title, season, episode, resume, duration, watched}]}. A movie has one item, a show its
    episodes in order. resume/duration are seconds."""
    src, token, ident = _access(user)
    it = arr.item(kind, ext_id)
    args = (kind, it.get("tmdb"), it.get("tvdb"), it["title"])
    try:
        items = _plex_items(token, *args) if src == "plex" else _jf_items(token, ident[3:], *args)
    except (httpx.HTTPError, ValueError, KeyError):
        raise PlayError(f"Couldn't reach {store.SOURCES[src]} right now.")
    if items is None:
        raise PlayError(f"It isn't in any of your {store.SOURCES[src]} libraries.")
    if not items:
        raise PlayError("No episodes of it are on the server yet.")
    return {"source": src, "items": items}


def _plex_items(token, kind, tmdb, tvdb, title):
    base, h = _plex_base(), _plex_h(token)
    d = _http.get(base + "/hubs/search", headers=h, params={"query": title, "includeGuids": 1, "limit": 20}).json()
    want = "movie" if kind == "movie" else "show"
    for hub in d.get("MediaContainer", {}).get("Hub", []):
        for m in hub.get("Metadata", []):
            if m.get("type") != want:
                continue
            ids = {}
            for g in m.get("Guid", []):
                s, _, v = g.get("id", "").partition("://")
                ids[s] = ids.get(s, ()) + (v,)
            if not media._match(ids, kind, tmdb, tvdb):
                continue
            if kind == "movie":
                return [_plex_shape(_http.get(f"{base}/library/metadata/{m['ratingKey']}", headers=h).json()["MediaContainer"]["Metadata"][0])]
            eps = _http.get(f"{base}/library/metadata/{m['ratingKey']}/allLeaves", headers=h).json()["MediaContainer"].get("Metadata", [])
            return [_plex_shape(e) for e in eps if e.get("Media")]
    return None


def _plex_shape(m):
    return {"id": str(m["ratingKey"]), "title": m.get("title") or "", "season": m.get("parentIndex"), "episode": m.get("index"),
            "resume": (m.get("viewOffset") or 0) / 1000, "duration": (m.get("duration") or 0) / 1000,
            "watched": bool(m.get("viewCount"))}


def _jf_items(token, uid, kind, tmdb, tvdb, title):
    base, h = _jf_base(), _jf_h(token)
    found = _http.get(base + "/Items", headers=h, params={
        "userId": uid, "Recursive": "true", "IncludeItemTypes": "Movie" if kind == "movie" else "Series", "SearchTerm": title,
        "Fields": "ProviderIds", "enableUserData": "true", "Limit": 25}).json().get("Items", [])
    for it in found:
        p = {k.lower(): (v,) for k, v in (it.get("ProviderIds") or {}).items()}
        if not media._match(p, kind, tmdb, tvdb):
            continue
        if kind == "movie":
            return [_jf_shape(it)]
        eps = _http.get(f"{base}/Shows/{it['Id']}/Episodes", headers=h, params={
            "userId": uid, "enableUserData": "true", "Fields": "MediaSources"}).json().get("Items", [])
        return [_jf_shape(e) for e in eps if e.get("LocationType") != "Virtual"]
    return None


def _jf_shape(m):
    ud = m.get("UserData") or {}
    return {"id": m["Id"], "title": m.get("Name") or "", "season": m.get("ParentIndexNumber"), "episode": m.get("IndexNumber"),
            "resume": (ud.get("PlaybackPositionTicks") or 0) / 1e7, "duration": (m.get("RunTimeTicks") or 0) / 1e7,
            "watched": bool(ud.get("Played"))}


# ---------- starting and stopping ----------
# Tells Jellyfin what the Apple player handles: HLS with fMP4 segments, H.264/HEVC video, AAC/AC3/E-AC3 audio.
# Anything else is converted; compatible streams are copied as-is.
JF_PROFILE = {
    "MaxStreamingBitrate": 120_000_000, "MaxStaticBitrate": 120_000_000,
    "DirectPlayProfiles": [],
    "TranscodingProfiles": [{"Container": "mp4", "Type": "Video", "VideoCodec": "h264,hevc", "AudioCodec": "aac,ac3,eac3",
                             "Context": "Streaming", "Protocol": "hls", "MaxAudioChannels": "6", "MinSegments": "1",
                             "BreakOnNonKeyFrames": True}],
    "SubtitleProfiles": [{"Format": "vtt", "Method": "Hls"}],
    "ContainerProfiles": [], "CodecProfiles": [],
}
# Browsers without built-in HLS (Chrome, Firefox) play through hls.js: H.264 + stereo AAC in MPEG-TS is what they all handle.
JF_PROFILE_WEB = {**JF_PROFILE, "TranscodingProfiles": [
    {"Container": "ts", "Type": "Video", "VideoCodec": "h264", "AudioCodec": "aac", "Context": "Streaming", "Protocol": "hls",
     "MaxAudioChannels": "2", "MinSegments": "1", "BreakOnNonKeyFrames": True}]}


def start(user, item_id, offset, platform, subtitle=None):
    """Start a stream of one movie/episode. Returns {url, session}; url is relative to the NuniFlix server.
    subtitle: a Plex/Jellyfin subtitle track to burn into the picture (0 = none, None = leave as it is)."""
    src, token, ident = _access(user)
    client = _client_id(user, platform)
    sid = secrets.token_urlsafe(32)
    s = {"sid": sid, "user": user["id"], "source": src, "token": token, "client": client, "platform": platform,
         "item": item_id, "seen": time.time(), "started": False, "subtitle": subtitle}
    try:
        if src == "plex":
            path, query = _plex_start(s, offset)
        else:
            path, query = _jf_start(s, ident[3:], offset)
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        raise PlayError(f"{store.SOURCES[src]} couldn't start that. Try again in a moment.")
    s["prefix"] = path.rsplit("/", 1)[0].lower() + "/"  # the only part of Plex/Jellyfin this stream may reach
    with _lock:
        _sweep()
        mine = sorted((x for x in _streams.values() if x["user"] == user["id"]), key=lambda x: x["seen"])
        for old in mine[:max(0, len(mine) - MAX_STREAMS + 1)]:
            _end(old)
        _streams[sid] = s
    return {"url": f"/api/stream/{sid}{path}?{query}", "session": sid}


def _plex_start(s, offset):
    params = {
        "path": f"/library/metadata/{s['item']}", "mediaIndex": 0, "partIndex": 0, "protocol": "hls", "fastSeek": 1,
        "directPlay": 0, "directStream": 1, "directStreamAudio": 1, "videoQuality": 100,
        "videoResolution": "3840x2160" if s["platform"] == "tvos" else "1920x1080", "maxVideoBitrate": 40000,
        # browsers: convert everything to H.264 + AAC (Plex would otherwise pass through HEVC / surround audio they can't play)
        **({"directStream": 0, "directStreamAudio": 0, "audioChannelCount": 2} if s["platform"] == "web" else {}),
        "subtitles": "auto", "subtitleSize": 100, "audioBoost": 100, "location": "lan", "offset": int(offset or 0),
        "session": s["sid"], "X-Plex-Session-Identifier": s["sid"], "X-Plex-Client-Identifier": s["client"],
        "X-Plex-Product": store.app_name(), "X-Plex-Platform": "iOS", "X-Plex-Device": _device(s["platform"]),
    }
    if s["subtitle"] is not None:  # Plex burns in the person's selected track for the title
        import subtitles
        subtitles.select_plex(s["token"], s["item"], s["subtitle"])
        params["subtitles"] = "burn" if s["subtitle"] else "auto"
    h = _plex_h(s["token"], s["client"], s["platform"])
    _http.get(_plex_base() + "/video/:/transcode/universal/decision", headers=h, params=params).raise_for_status()
    s["duration"] = 0
    return "/video/:/transcode/universal/start.m3u8", urllib.parse.urlencode(params)


def _jf_start(s, uid, offset):
    profile = JF_PROFILE_WEB if s["platform"] == "web" else JF_PROFILE
    body = {"UserId": uid, "StartTimeTicks": int((offset or 0) * 1e7), "DeviceProfile": profile,
            "EnableDirectPlay": False, "EnableDirectStream": False, "AutoOpenLiveStream": True}
    if s["subtitle"]:  # burn the chosen track into the picture
        body["SubtitleStreamIndex"] = int(s["subtitle"])
        body["DeviceProfile"] = {**profile, "SubtitleProfiles": [{"Format": f, "Method": "Encode"} for f in
                                                                 ("srt", "subrip", "ass", "ssa", "vtt", "webvtt", "pgssub", "dvdsub", "sub")]}
    elif s["subtitle"] == 0:
        body["SubtitleStreamIndex"] = -1
    r = _http.post(f"{_jf_base()}/Items/{s['item']}/PlaybackInfo", headers=_jf_h(s["token"], s["client"], s["platform"]),
                   params={"userId": uid}, json=body)
    r.raise_for_status()
    d = r.json()
    src = d["MediaSources"][0]
    s.update(play_session=d.get("PlaySessionId"), media_source=src["Id"])
    url = src.get("TranscodingUrl")
    if not url:
        raise ValueError("no transcoding url")
    path, _, query = url.partition("?")
    return path, TOKEN_PARAMS.sub(r"\1", query).rstrip("&")


def progress(user, sid, position, state, duration=None):
    """The player reports where it is every few seconds (state playing/paused) and when it closes (stopped)."""
    with _lock:
        s = _streams.get(sid)
        if not s or s["user"] != user["id"]:
            raise PlayError("That stream has ended.")
        s["seen"] = time.time()
        if state == "stopped":
            _streams.pop(sid, None)
    try:
        if s["source"] == "plex":
            _plex_timeline(s, position, state, duration)
        else:
            _jf_report(s, position, state)
    except httpx.HTTPError:
        pass  # a missed progress report isn't worth interrupting the film for
    if state == "stopped":
        _stop_transcode(s)


def _plex_timeline(s, position, state, duration):
    _http.get(_plex_base() + "/:/timeline", headers=_plex_h(s["token"], s["client"], s["platform"]), params={
        "ratingKey": s["item"], "key": f"/library/metadata/{s['item']}", "state": state, "time": int(position * 1000),
        "duration": int((duration or 0) * 1000), "X-Plex-Session-Identifier": s["sid"]})


def _jf_report(s, position, state):
    body = {"ItemId": s["item"], "MediaSourceId": s["media_source"], "PlaySessionId": s["play_session"],
            "PositionTicks": int(position * 1e7), "IsPaused": state == "paused", "PlayMethod": "Transcode", "CanSeek": True}
    h = _jf_h(s["token"], s["client"], s["platform"])
    if state == "stopped":
        _http.post(_jf_base() + "/Sessions/Playing/Stopped", headers=h, json=body)
        return
    if not s["started"]:
        s["started"] = True
        _http.post(_jf_base() + "/Sessions/Playing", headers=h, json=body)
    _http.post(_jf_base() + "/Sessions/Playing/Progress", headers=h, json=body)


def _stop_transcode(s):
    try:
        if s["source"] == "plex":
            _http.get(_plex_base() + "/video/:/transcode/universal/stop", headers=_plex_h(s["token"], s["client"], s["platform"]),
                      params={"session": s["sid"]})
        else:
            _http.delete(_jf_base() + "/Videos/ActiveEncodings", headers=_jf_h(s["token"], s["client"], s["platform"]),
                         params={"deviceId": s["client"], "playSessionId": s["play_session"]})
    except httpx.HTTPError:
        pass


def _end(s):
    """Drop a stream (caller holds _lock) and stop its transcode in the background."""
    _streams.pop(s["sid"], None)
    threading.Thread(target=_stop_transcode, args=(s,), daemon=True).start()


def _sweep():
    now = time.time()
    for s in [s for s in _streams.values() if now - s["seen"] > STREAM_IDLE]:
        _end(s)


# ---------- the pipe ----------
def fetch(sid, path, query, range_header=None):
    """Proxy one playlist/segment request. Returns (status, headers, body bytes | byte iterator)."""
    with _lock:
        s = _streams.get(sid)
        if s:
            s["seen"] = time.time()
    path = "/" + path.lstrip("/")
    if not s or not path.lower().startswith(s["prefix"]) or ".." in path:
        return 404, {}, b"Stream not found or ended."
    base = _plex_base() if s["source"] == "plex" else _jf_base()
    h = {"X-Plex-Token": s["token"], "X-Plex-Client-Identifier": s["client"]} if s["source"] == "plex" else {"X-Emby-Token": s["token"]}
    if range_header:
        h["Range"] = range_header
    url = base + urllib.parse.quote(path, safe="/:%") + ("?" + query if query else "")
    try:
        r = _pipe.send(_pipe.build_request("GET", url, headers=h), stream=True)
    except httpx.HTTPError:
        return 502, {}, b"The media server didn't answer."
    keep = {k: r.headers[k] for k in ("content-type", "content-length", "content-range", "accept-ranges", "cache-control") if k in r.headers}
    if path.endswith(".m3u8") or "mpegurl" in r.headers.get("content-type", ""):
        try:
            text = r.read().decode("utf-8", "replace")
        finally:
            r.close()
        text = re.sub(r"\?(?=\s|$)", "", TOKEN_PARAMS.sub(r"\1", text))  # their token must not reach the device
        keep.pop("content-length", None)
        keep["content-type"] = "application/vnd.apple.mpegurl"
        return r.status_code, keep, text.encode()

    def body():
        try:
            yield from r.iter_bytes(64 * 1024)
        finally:
            r.close()
    return r.status_code, keep, body()
