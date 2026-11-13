"""Your library: what's actually on the person's own Plex/Jellyfin (their libraries, their "continue watching"),
laid out like a service page: Continue watching, Recently added, Movies, Shows, then its genres.

Posters and backdrops come from Plex/Jellyfin through NuniFlix (/api/art/<id>). The id is an unguessable token that
maps to one image on the server, so the Apple TV can load it without a sign-in header and the server's address and
token never leave NuniFlix.
"""
import collections, secrets, threading, time

import httpx

import arr, history, player, store

_http = httpx.Client(timeout=15, headers={"Accept": "application/json"})
PAGE = 24

# ---------- artwork ----------
_art, _art_rev, _art_bytes, _art_lock = collections.OrderedDict(), {}, {}, threading.Lock()
SIZES = {"poster": (342, 513), "backdrop": (1280, 720)}


def art_url(src, path, kind):
    if not path:
        return None
    with _art_lock:
        aid = _art_rev.get((src, path, kind))
        if not aid:
            aid = secrets.token_urlsafe(12)
            _art[aid] = (src, path, kind)
            _art_rev[(src, path, kind)] = aid
            while len(_art) > 5000:
                old, key = _art.popitem(last=False)
                _art_rev.pop(key, None)
                _art_bytes.pop(old, None)
    return f"/api/art/{aid}"


def art(aid):
    """(bytes, content type) for an art id, fetched with the server's own credentials and kept a while."""
    entry = _art.get(aid)
    if not entry:
        return None
    hit = _art_bytes.get(aid)
    if hit and hit[0] > time.time():
        return hit[1], hit[2]
    src, path, kind = entry
    w, h = SIZES[kind]
    conn = history._plex() if src == "plex" else history._jf()
    if not conn:
        return None
    base, hdr = conn
    try:
        if src == "plex":
            r = _http.get(base + "/photo/:/transcode", headers=hdr, params={"url": path, "width": w, "height": h, "minSize": 1, "upscale": 1})
        else:
            r = _http.get(base + path, headers=hdr, params={"maxWidth": w, "quality": 85})
    except httpx.HTTPError:
        return None
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
        return None
    with _art_lock:
        _art_bytes[aid] = (time.time() + 3600, r.content, r.headers["content-type"])
        while len(_art_bytes) > 600:
            _art_bytes.pop(next(iter(_art_bytes)))
    return r.content, r.headers["content-type"]


# ---------- Plex ----------
def _px(token, path, **params):
    return _http.get(player._plex_base() + path, headers=player._plex_h(token), params=params).json()["MediaContainer"]


def _plex_sections(token):
    d = arr.cached(f"lib:px:sections:{token[-8:]}", 600, lambda: _px(token, "/library/sections"))
    return [(s["key"], "movie" if s["type"] == "movie" else "tv") for s in d.get("Directory", []) if s.get("type") in ("movie", "show")]


def _plex_genre_ids(token, section):
    d = arr.cached(f"lib:px:genres:{token[-8:]}:{section}", 3600, lambda: _px(token, f"/library/sections/{section}/genre"))
    return {g["title"]: g["key"] for g in d.get("Directory", [])}


def _plex_show_ids(token, rating_key):
    """tmdb / tvdb ids of a show (episodes only carry their own ids)."""
    def load():
        m = _px(token, f"/library/metadata/{rating_key}", includeGuids=1)["Metadata"][0]
        return _guids(m)
    return arr.cached(f"lib:px:show:{rating_key}", 86400, load)


def _guids(m):
    out = {}
    for g in m.get("Guid", []):
        s, _, v = g.get("id", "").partition("://")
        if s in ("tmdb", "tvdb") and v.isdigit():
            out[s] = int(v)
    return out


def _plex_shape(token, m):
    kind = "movie" if m.get("type") == "movie" else "tv"
    if m.get("type") == "episode":
        ids = _plex_show_ids(token, m.get("grandparentRatingKey"))
        title, thumb, back, year = m.get("grandparentTitle"), m.get("grandparentThumb"), m.get("grandparentArt"), None
        sub = f"S{m.get('parentIndex')} · E{m.get('index')}"
    else:
        ids = _guids(m)
        title, thumb, back, year, sub = m.get("title"), m.get("thumb"), m.get("art"), m.get("year"), None
    ext = ids.get("tmdb") if kind == "movie" else ids.get("tvdb")
    if kind == "movie" and not ext:
        return None  # NuniFlix can only open movies it can look up
    return {"type": kind, "id": ext, "tmdb": ids.get("tmdb"), "title": title, "year": year, "sub": sub,
            "poster": art_url("plex", thumb, "poster"), "backdrop": art_url("plex", back, "backdrop"),
            "overview": m.get("summary"), "genres": [g["tag"] for g in m.get("Genre", [])][:3], "status": "available",
            "added": m.get("addedAt") or 0}


def _plex_list(token, kind, genre, start, size):
    out = []
    for key, k in _plex_sections(token):
        if kind != "all" and k != kind:
            continue
        params = {"type": 1 if k == "movie" else 2, "sort": "addedAt:desc", "includeGuids": 1,
                  "X-Plex-Container-Start": start, "X-Plex-Container-Size": size}
        if genre:
            gid = _plex_genre_ids(token, key).get(genre)
            if not gid:
                continue
            params["genre"] = gid
        d = _px(token, f"/library/sections/{key}/all", **params)
        out += [x for x in (_plex_shape(token, m) for m in d.get("Metadata", [])) if x]
    return sorted(out, key=lambda x: -x["added"])


def _plex_resume(token):
    d = _px(token, "/library/onDeck", includeGuids=1)
    return [x for x in (_plex_shape(token, m) for m in d.get("Metadata", [])[:20]) if x]


def _plex_genres(token):
    seen = collections.Counter()
    for key, _ in _plex_sections(token):
        for g in _plex_genre_ids(token, key):
            seen[g] += 1
    return list(seen)


# ---------- Jellyfin ----------
FIELDS = "ProviderIds,Overview,Genres,ProductionYear,DateCreated"


def _jfget(token, path, **params):
    return _http.get(player._jf_base() + path, headers=player._jf_h(token), params=params).json()


def _jf_series_ids(token, uid, sid):
    def load():
        it = _jfget(token, f"/Items/{sid}", userId=uid)
        return {k.lower(): int(v) for k, v in (it.get("ProviderIds") or {}).items() if k.lower() in ("tmdb", "tvdb") and str(v).isdigit()}
    return arr.cached(f"lib:jf:series:{sid}", 86400, load)


def _jf_shape(token, uid, it):
    t = it.get("Type")
    kind = "movie" if t == "Movie" else "tv"
    if t == "Episode":
        ids = _jf_series_ids(token, uid, it.get("SeriesId"))
        iid, title, year = it.get("SeriesId"), it.get("SeriesName"), None
        sub = f"S{it.get('ParentIndexNumber')} · E{it.get('IndexNumber')}"
    else:
        ids = {k.lower(): int(v) for k, v in (it.get("ProviderIds") or {}).items() if k.lower() in ("tmdb", "tvdb") and str(v).isdigit()}
        iid, title, year, sub = it["Id"], it.get("Name"), it.get("ProductionYear"), None
    ext = ids.get("tmdb") if kind == "movie" else ids.get("tvdb")
    if kind == "movie" and not ext:
        return None
    return {"type": kind, "id": ext, "tmdb": ids.get("tmdb"), "title": title, "year": year, "sub": sub,
            "poster": art_url("jellyfin", f"/Items/{iid}/Images/Primary", "poster"),
            "backdrop": art_url("jellyfin", f"/Items/{iid}/Images/Backdrop", "backdrop"),
            "overview": it.get("Overview"), "genres": (it.get("Genres") or [])[:3], "status": "available",
            "added": it.get("DateCreated") or ""}


def _jf_list(token, uid, kind, genre, start, size):
    types = {"movie": "Movie", "tv": "Series", "all": "Movie,Series"}[kind]
    params = {"userId": uid, "Recursive": "true", "IncludeItemTypes": types, "SortBy": "DateCreated", "SortOrder": "Descending",
              "Fields": FIELDS, "StartIndex": start * (2 if kind == "all" else 1), "Limit": size * (2 if kind == "all" else 1)}
    if genre:
        params["Genres"] = genre
    d = _jfget(token, "/Items", **params)
    return [x for x in (_jf_shape(token, uid, it) for it in d.get("Items", [])) if x]


def _jf_resume(token, uid):
    try:
        d = _jfget(token, "/UserItems/Resume", userId=uid, Limit=20, Fields=FIELDS)
    except ValueError:
        d = _jfget(token, f"/Users/{uid}/Items/Resume", Limit=20, Fields=FIELDS)
    return [x for x in (_jf_shape(token, uid, it) for it in d.get("Items", [])) if x]


def _jf_genres(token, uid):
    d = _jfget(token, "/Genres", userId=uid, Recursive="true", IncludeItemTypes="Movie,Series", SortBy="SortName")
    return [g["Name"] for g in d.get("Items", [])]


# ---------- what the apps ask for ----------
def _src(user):
    src, token, ident = player._access(user)
    return src, token, ident[3:] if src == "jellyfin" else None


def _list(user, kind, genre, page):
    src, token, uid = _src(user)
    start = (page - 1) * PAGE
    return _plex_list(token, kind, genre, start, PAGE) if src == "plex" else _jf_list(token, uid, kind, genre, start, PAGE)


def dedupe(rows, keep=20):
    """Each title once per page: in the first row it's in. Rows keep up to `keep` titles."""
    seen = set()
    for r in rows:
        fresh = []
        for x in r["items"]:
            k = (x["type"], x.get("tmdb") or x.get("id"))
            if k not in seen:
                seen.add(k)  # only what the row actually shows counts as used
                fresh.append(x)
                if len(fresh) >= keep:
                    break
        r["items"] = fresh
    return [r for r in rows if r["items"]]


def rows(user, genre=None):
    """{source, name, hero, rows, genres}: the library page, or one genre of it."""
    src, token, uid = _src(user)
    name = store.SOURCES[src]
    try:
        out = []
        if not genre:
            resume = _plex_resume(token) if src == "plex" else _jf_resume(token, uid)
            if resume:
                out.append({"key": "resume", "title": "Continue watching", "type": "all", "sort": "added", "cat": None, "items": resume, "page": 1})
        label = f"New in {genre.lower()}" if genre else "Recently added"
        for key, title, kind in (("added", label, "all"), ("movies", "Movies", "movie"), ("shows", "Shows", "tv")):
            items = _list(user, kind, genre, 1) + _list(user, kind, genre, 2)
            out.append({"key": key, "title": title, "type": kind, "sort": "added", "cat": genre, "items": items, "page": 2})
        genres = [] if genre else (_plex_genres(token) if src == "plex" else _jf_genres(token, uid))
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        raise player.PlayError(f"Couldn't reach {name} right now.")
    out = dedupe(out)
    hero = next((x for r in out for x in r["items"] if x.get("backdrop") and x.get("overview")), None)
    return {"source": src, "name": name, "hero": hero, "rows": out, "genres": [{"key": g, "title": g} for g in genres[:24]]}


def page(user, kind, genre, n):
    try:
        items = _list(user, kind, genre, n)
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        raise player.PlayError("Couldn't reach your library right now.")
    return {"results": items, "page": n, "total_pages": n + 1 if len(items) >= PAGE else n}
