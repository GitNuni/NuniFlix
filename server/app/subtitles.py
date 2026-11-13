"""Subtitles for "Play here".

Tracks already on the title (in the file, or added earlier) come from the person's own Plex/Jellyfin, whatever the
setting. "Find subtitles" searches the source the owner picked (Settings → Subtitles, config["subtitles"]["source"]):

  plex          Plex fetches from OpenSubtitles and adds it to the title (everyone gets it after that)
  jellyfin      the same through Jellyfin (needs Jellyfin's OpenSubtitles plugin)
  opensubtitles NuniFlix asks OpenSubtitles.com itself with the owner's API key; the file is kept in /data/subtitles
                and drawn over the video by the player (works for Plex and Jellyfin alike)

If the source is Plex but this stream is from Jellyfin (or the other way round), the stream's own server is used:
a Plex search can only add subtitles to a Plex title.

Picking a Plex/Jellyfin track restarts the stream with it burned into the picture (player.start(subtitle=...)),
which every player shows the same way.
"""
import os, re, threading, time

import httpx

import arr, player, store

OS_API = "https://api.opensubtitles.com/api/v1"
SUB_DIR = os.path.join(store.DATA, "subtitles")
_http = httpx.Client(timeout=20, headers={"Accept": "application/json"})
_os_login = {"token": None, "at": 0, "user": None}
_os_lock = threading.Lock()
# OpenSubtitles takes ISO 639-1 ("en"); Jellyfin's subtitle search wants ISO 639-2 ("eng").
LANG3 = {"en": "eng", "es": "spa", "fr": "fre", "de": "ger", "it": "ita", "pt": "por", "nl": "dut", "sv": "swe", "da": "dan",
         "no": "nor", "fi": "fin", "pl": "pol", "ru": "rus", "ja": "jpn", "ko": "kor", "zh": "chi", "ar": "ara", "tr": "tur",
         "he": "heb", "el": "gre", "hi": "hin", "cs": "cze", "hu": "hun", "ro": "rum", "uk": "ukr", "vi": "vie", "th": "tha"}


class SubError(Exception):
    pass


def settings():
    return store.config()["subtitles"]


def _owner_plex():
    c = store.config()["plex"]
    return c["url"].rstrip("/"), player._plex_h(c.get("token") or "")


def _jf_admin():
    c = store.config()["jellyfin"]
    return c["url"].rstrip("/"), {"Accept": "application/json", "X-Emby-Token": c["key"]}


# ---------- tracks already on the title ----------
def tracks(user, item_id):
    """{"source": "plex"|"jellyfin", "tracks": [{id, title, language}]}: the person's view of the title."""
    src, token, ident = player._access(user)
    try:
        if src == "plex":
            part = _plex_part(token, item_id)
            out = [{"id": s["id"], "title": s.get("extendedDisplayTitle") or s.get("displayTitle") or s.get("language") or "Subtitles",
                    "language": s.get("languageCode")} for s in part.get("Stream", []) if s.get("streamType") == 3]
        else:
            base = player._jf_base()
            it = _http.get(f"{base}/Items/{item_id}", headers=player._jf_h(token), params={"userId": ident[3:]}).json()
            streams = ((it.get("MediaSources") or [{}])[0].get("MediaStreams") or it.get("MediaStreams") or [])
            out = [{"id": s["Index"], "title": s.get("DisplayTitle") or s.get("Language") or "Subtitles", "language": s.get("Language")}
                   for s in streams if s.get("Type") == "Subtitle"]
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        raise SubError(f"Couldn't get the subtitles from {store.SOURCES[src]}.")
    return {"source": src, "tracks": out}


def _plex_part(token, item_id):
    m = _http.get(f"{player._plex_base()}/library/metadata/{item_id}", headers=player._plex_h(token)).json()["MediaContainer"]["Metadata"][0]
    return m["Media"][0]["Part"][0]


def select_plex(token, item_id, stream_id):
    """Make this the person's subtitle for the title in Plex (0 = none), so the next transcode burns it in."""
    part = _plex_part(token, item_id)
    _http.put(f"{player._plex_base()}/library/parts/{part['id']}", headers=player._plex_h(token),
              params={"subtitleStreamID": int(stream_id or 0), "allParts": 1}).raise_for_status()


# ---------- finding more ----------
def _provider(stream_src):
    """Which search to use for a stream from Plex/Jellyfin: the owner's pick, or the stream's own server."""
    want = settings()["source"]
    if want == "opensubtitles":
        if not settings()["key"]:
            raise SubError("Subtitles are set to OpenSubtitles, but there's no API key yet (Settings → Subtitles).")
        return "opensubtitles"
    return stream_src  # "plex"/"jellyfin": a search can only add subtitles to that server's own title


def search(user, kind, ext_id, item_id, season=None, episode=None, language=None):
    src, _, _ = player._access(user)
    lang = (language or settings()["language"] or "en").lower()[:2]
    prov = _provider(src)
    try:
        if prov == "opensubtitles":
            results = _os_search(kind, ext_id, season, episode, lang)
        elif prov == "plex":
            results = _plex_search(item_id, lang)
        else:
            results = _jf_search(item_id, lang)
    except httpx.HTTPError:
        raise SubError(f"{_name(prov)} didn't answer. Try again in a moment.")
    return {"provider": prov, "language": lang, "results": results}


def get(user, kind, item_id, result_id, provider):
    """Fetch one search result. Plex/Jellyfin: it becomes a track on the title -> {"track": id, "tracks": [...]}.
    OpenSubtitles: kept by NuniFlix -> {"vtt": url}."""
    src, _, _ = player._access(user)
    if provider != _provider(src):
        raise SubError("The subtitle setting changed. Search again.")
    try:
        if provider == "opensubtitles":
            return {"vtt": f"/api/subtitles/{_os_fetch(result_id)}.vtt"}
        before = {t["id"] for t in tracks(user, item_id)["tracks"]}
        if provider == "plex":
            _plex_fetch(item_id, result_id)
        else:
            _jf_fetch(item_id, result_id)
        for _ in range(8):  # the server takes a moment to download it and list it
            now = tracks(user, item_id)["tracks"]
            new = [t for t in now if t["id"] not in before]
            if new:
                return {"track": new[-1]["id"], "tracks": now}
            time.sleep(1.5)
    except httpx.HTTPError:
        raise SubError(f"{_name(provider)} couldn't get that one. Try another.")
    raise SubError(f"{_name(provider)} said yes but the subtitles haven't shown up yet. Try again in a minute.")


def _name(prov):
    return {"plex": "Plex", "jellyfin": "Jellyfin", "opensubtitles": "OpenSubtitles"}[prov]


def _plex_search(item_id, lang):
    base, h = _owner_plex()
    d = _http.get(f"{base}/library/metadata/{item_id}/subtitles", headers=h,
                  params={"language": lang, "hearingImpaired": 0, "forced": 0}).json()
    out = []
    for s in d.get("MediaContainer", {}).get("Stream", []):
        if not s.get("key"):
            continue
        out.append({"id": s["key"], "title": s.get("title") or s.get("displayTitle") or "Subtitles",
                    "language": s.get("languageCode") or lang, "downloads": s.get("score"), "hi": bool(s.get("hearingImpaired")),
                    "codec": s.get("codec"), "from": s.get("providerTitle") or "Plex"})
    return out


def _plex_fetch(item_id, key):
    base, h = _owner_plex()
    _http.put(f"{base}/library/metadata/{item_id}/subtitles", headers=h, params={"key": key}).raise_for_status()


def _jf_search(item_id, lang):
    base, h = _jf_admin()
    r = _http.get(f"{base}/Items/{item_id}/RemoteSearch/Subtitles/{LANG3.get(lang, lang)}", headers=h)
    if r.status_code == 404:
        raise SubError("Jellyfin has no subtitle search. Install its OpenSubtitles plugin, or switch Settings → Subtitles to an OpenSubtitles key.")
    r.raise_for_status()
    return [{"id": x["Id"], "title": x.get("Name") or "Subtitles", "language": lang, "downloads": x.get("DownloadCount"),
             "hi": bool(x.get("HearingImpaired")), "from": x.get("ProviderName") or "Jellyfin"} for x in r.json()]


def _jf_fetch(item_id, sub_id):
    base, h = _jf_admin()
    _http.post(f"{base}/Items/{item_id}/RemoteSearch/Subtitles/{sub_id}", headers=h).raise_for_status()


# ---------- OpenSubtitles.com (the owner's own API key) ----------
def _os_headers(token=None):
    import main  # the version, for the User-Agent OpenSubtitles requires
    h = {"Api-Key": settings()["key"], "User-Agent": f"{store.app_name()} v{main.VERSION}", "Accept": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    return h


def _os_token():
    """Signed in to OpenSubtitles (if a username is set) for the account's bigger daily download allowance."""
    c = settings()
    if not (c["username"] and c["secret"]):
        return None
    with _os_lock:
        if _os_login["token"] and _os_login["user"] == c["username"] and time.time() - _os_login["at"] < 20 * 3600:
            return _os_login["token"]
        r = _http.post(OS_API + "/login", headers=_os_headers(), json={"username": c["username"], "password": c["secret"]})
        if r.status_code in (400, 401):
            raise SubError("OpenSubtitles didn't accept that username and password (Settings → Subtitles).")
        r.raise_for_status()
        _os_login.update(token=r.json()["token"], at=time.time(), user=c["username"])
        return _os_login["token"]


def _os_search(kind, ext_id, season, episode, lang):
    tmdb_id = ext_id if kind == "movie" else arr.item(kind, ext_id).get("tmdb")
    if not tmdb_id:
        raise SubError("Can't look this one up on OpenSubtitles.")
    params = {"languages": lang, "order_by": "download_count"}
    if kind == "movie":
        params["tmdb_id"] = tmdb_id
    else:
        params.update(parent_tmdb_id=tmdb_id, season_number=season or 1, episode_number=episode or 1)
    def load():  # an error isn't remembered, only a good answer
        r = _http.get(OS_API + "/subtitles", headers=_os_headers(), params=params)
        if r.status_code in (401, 403):
            raise SubError("OpenSubtitles didn't accept the API key (Settings → Subtitles).")
        r.raise_for_status()
        return r.json()
    out = []
    for d in arr.cached(f"os:search:{kind}:{tmdb_id}:{season}:{episode}:{lang}", 3600, load).get("data", []):
        a = d.get("attributes") or {}
        f = (a.get("files") or [None])[0]
        if f:
            out.append({"id": str(f["file_id"]), "title": a.get("release") or f.get("file_name") or "Subtitles",
                        "language": a.get("language") or lang, "downloads": a.get("download_count"),
                        "hi": bool(a.get("hearing_impaired")), "from": "OpenSubtitles"})
    return out[:40]


def _os_fetch(file_id):
    if not str(file_id).isdigit():
        raise SubError("That isn't an OpenSubtitles file.")
    path = os.path.join(SUB_DIR, f"{file_id}.vtt")
    if os.path.exists(path):  # fetched before: free
        return file_id
    r = _http.post(OS_API + "/download", headers=_os_headers(_os_token()), json={"file_id": int(file_id), "sub_format": "webvtt"})
    if r.status_code == 406:
        raise SubError("Today's OpenSubtitles downloads are used up. Add an OpenSubtitles username in Settings → Subtitles for more.")
    if r.status_code in (401, 403):
        raise SubError("OpenSubtitles didn't accept the API key (Settings → Subtitles).")
    r.raise_for_status()
    text = _http.get(r.json()["link"], headers={"Accept": "*/*"}).text
    os.makedirs(SUB_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(to_vtt(text))
    return file_id


def to_vtt(text):
    """WebVTT as-is; SRT converted (comma decimals, WEBVTT header)."""
    text = text.lstrip("﻿").replace("\r\n", "\n")
    if text.startswith("WEBVTT"):
        return text
    return "WEBVTT\n\n" + re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)


def vtt_path(file_id):
    p = os.path.join(SUB_DIR, f"{file_id}.vtt")
    return p if str(file_id).isdigit() and os.path.exists(p) else None
