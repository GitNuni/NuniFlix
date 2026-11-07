"""Radarr / Sonarr: search, library status, download progress, and adding requests.

Search uses the *arr lookup endpoints, so no TMDB/TVDB key is needed.
Movies are identified by TMDB id, shows by TVDB id (what Radarr/Sonarr key on).
Each app can have a second 4K server: config sections radarr4k / sonarr4k ("srv" below is one of the four).
"""
import threading, time
from concurrent.futures import ThreadPoolExecutor

import httpx

import store

_http = httpx.Client(timeout=20, headers={"Accept": "application/json"})
_cache, _cache_lock = {}, threading.Lock()
_pool = ThreadPoolExecutor(4)


class ArrError(Exception):
    pass


NAMES = {"radarr": "Radarr", "sonarr": "Sonarr", "radarr4k": "Radarr 4K", "sonarr4k": "Sonarr 4K"}


def _cfg(kind):
    c = store.config()[kind]
    if not c["url"] or not c["key"]:
        raise ArrError(f"{NAMES[kind]} isn't connected yet.")
    return c


def has(srv):
    c = store.config()[srv]
    return bool(c["url"] and c["key"])


def srv_for(kind, is4k=False):
    return ("radarr" if kind == "movie" else "sonarr") + ("4k" if is4k else "")


def call(kind, method, path, conn=None, **kw):
    c = conn or _cfg(kind)
    try:
        r = _http.request(method, c["url"].rstrip("/") + path, headers={"X-Api-Key": c["key"]}, **kw)
    except httpx.HTTPError:
        raise ArrError(f"{NAMES[kind]} isn't reachable right now.")
    if r.status_code >= 400:
        try:
            msg = r.json()
            msg = msg[0].get("errorMessage") if isinstance(msg, list) else msg.get("message")
        except Exception:
            msg = None
        raise ArrError(msg or f"{NAMES[kind]} answered {r.status_code}.")
    return r.json() if r.content else None


_key_locks = {}


def cached(key, ttl, fn):
    """fn() at most every `ttl` seconds. Callers asking for the same key at once wait for one fetch instead of each doing it."""
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        if len(_cache) > 2000:  # forget entries nobody can use any more (searches, one-off lookups)
            now = time.time()
            for k in [k for k, v in _cache.items() if now - v[0] > v[2]]:
                _cache.pop(k, None)
                _key_locks.pop(k, None)
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:
        with _cache_lock:  # someone else may have just filled it
            hit = _cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
        val = fn()
        with _cache_lock:
            _cache[key] = (time.time(), val, ttl)
        return val


def invalidate(*prefixes):
    """Drop cached entries whose key starts with any prefix (everything when none given)."""
    with _cache_lock:
        for k in [k for k in _cache if not prefixes or k.startswith(prefixes)]:
            _cache.pop(k, None)


# ---------- library ----------
def movie_lib(srv="radarr"):
    return cached("movies:" + srv, 60, lambda: {m["tmdbId"]: m for m in call(srv, "GET", "/api/v3/movie")})


def tv_lib(srv="sonarr"):
    return cached("series:" + srv, 60, lambda: {s["tvdbId"]: s for s in call(srv, "GET", "/api/v3/series")})


def _secs(t):
    """Radarr/Sonarr timeleft ('00:12:34' or '1.02:03:04') in seconds."""
    try:
        days, hms = (t.split(".", 1) if "." in t.split(":")[0] else ("0", t))
        h, m, sec = (float(x) for x in hms.split(":"))
        return int(int(days) * 86400 + h * 3600 + m * 60 + sec)
    except (AttributeError, ValueError):
        return None


def _queue_info(kind):
    """{movie/series id: {pct, left (seconds or None), stuck}} for what's downloading right now."""
    def load():
        recs = call(kind, "GET", "/api/v3/queue", params={"pageSize": 500})["records"]
        out = {}
        for r in recs:
            oid = r.get("movieId") if kind.startswith("radarr") else r.get("seriesId")
            if oid is None or not r.get("size"):
                continue
            agg = out.setdefault(oid, {"size": 0, "sizeleft": 0, "left": None, "stuck": False})
            agg["size"] += r["size"]
            agg["sizeleft"] += r.get("sizeleft", 0)
            left = _secs(r.get("timeleft"))
            if left is not None:
                agg["left"] = max(agg["left"] or 0, left)
            if r.get("trackedDownloadStatus") in ("warning", "error") or r.get("status") in ("warning", "failed"):
                agg["stuck"] = True
        return {k: {"pct": round(100 * (v["size"] - v["sizeleft"]) / v["size"]), "left": v["left"], "stuck": v["stuck"]}
                for k, v in out.items()}
    return cached("queue:" + kind, 15, load)


def _queue(kind):
    return {k: v["pct"] for k, v in _queue_info(kind).items()}


def _day(iso):
    """'Nov 14' from an ISO date, or None if it's missing or already passed."""
    if not iso or iso[:10] <= time.strftime("%Y-%m-%d"):
        return None
    t = time.strptime(iso[:10], "%Y-%m-%d")
    return time.strftime("%b ", t) + str(t.tm_mday)


def why(kind, ext_id, is4k=False):
    """Why an approved request isn't watchable yet, in a few words (None if there's nothing useful to say)."""
    srv = srv_for(kind, is4k)
    lib = safe(lambda: (movie_lib if kind == "movie" else tv_lib)(srv), {}).get(ext_id)
    if not lib:
        return None
    q = safe(lambda: _queue_info(srv), {}).get(lib["id"])
    if q:
        if q["stuck"]:
            return "stuck · the owner can see it"
        left = q["left"]
        if left is None:
            return None
        return "about " + (f"{max(1, left // 60)}m" if left < 3600 else f"{left // 3600}h" if left < 86400 else f"{left // 86400}d") + " left"
    if kind == "movie":
        if lib.get("hasFile"):
            return None
        theaters, digital, disc = _day(lib.get("inCinemas")), _day(lib.get("digitalRelease")), _day(lib.get("physicalRelease"))
        if theaters:
            return f"In theaters {theaters}"
        if not lib.get("isAvailable"):
            if digital:
                return f"In theaters · digital release {digital}"
            if disc:
                return f"In theaters · out on disc {disc}"
            return "In theaters · no digital release date yet"
        return "Released · looking for a good copy"
    nxt = _day(lib.get("nextAiring"))
    st = lib.get("statistics") or {}
    if st.get("episodeCount") and st.get("episodeFileCount", 0) >= st["episodeCount"]:
        return f"Caught up · next episode {nxt}" if nxt else None
    return f"Looking for episodes · next one airs {nxt}" if nxt else "Looking for the missing episodes"


def safe(fn, default):
    try:
        return fn()
    except ArrError:
        return default


def state(kind, ext_id, is4k=False):
    """(status, progress) from the cached library, without extra lookups."""
    srv = srv_for(kind, is4k)
    if is4k and not has(srv):
        return None, None
    if kind == "movie":
        lib = safe(lambda: movie_lib(srv), {}).get(ext_id)
        if not lib:
            return "none", None
        if lib.get("hasFile"):
            return "available", None
        return "processing", safe(lambda: _queue(srv), {}).get(lib["id"])
    lib = safe(lambda: tv_lib(srv), {}).get(ext_id)
    if not lib:
        return "none", None
    st = lib.get("statistics") or {}
    have, want = st.get("episodeFileCount", 0), st.get("episodeCount", 0)
    prog = safe(lambda: _queue(srv), {}).get(lib["id"])
    if want and have >= want:
        return "available", prog
    return ("partial" if have else "processing"), prog


# ---------- shaping ----------
def _img(images, kind, remote=None):
    url = remote or next((i.get("remoteUrl") for i in images or [] if i.get("coverType") == kind), None)
    if url and "image.tmdb.org" in url:
        url = url.replace("/original/", "/w342/" if kind == "poster" else "/w1280/")
    return url


def shape_movie(m):
    lib = safe(movie_lib, {}).get(m.get("tmdbId"))
    status, progress = "none", None
    if lib:
        if lib.get("hasFile"):
            status = "available"
        elif lib.get("monitored"):
            status = "processing"
            progress = safe(lambda: _queue("radarr"), {}).get(lib["id"])
    src = lib or m
    return {
        "type": "movie", "id": m.get("tmdbId"), "tmdb": m.get("tmdbId"), "imdb": m.get("imdbId"),
        "title": m.get("title"), "year": m.get("year") or None, "overview": m.get("overview"),
        "poster": _img(src.get("images"), "poster", m.get("remotePoster")),
        "backdrop": _img(src.get("images"), "fanart"),
        "runtime": m.get("runtime") or None, "genres": m.get("genres", [])[:3],
        "certification": m.get("certification"), "studio": m.get("studio"),
        "rating": (m.get("ratings") or {}).get("tmdb", {}).get("value") or None,
        "released": m.get("digitalRelease") or m.get("physicalRelease") or m.get("inCinemas"),
        "status": status, "progress": progress,
        "status4k": state("movie", m.get("tmdbId"), True)[0],
    }


def shape_series(s):
    lib = safe(tv_lib, {}).get(s.get("tvdbId"))
    status, progress, seasons = "none", None, []
    if lib:
        st = lib.get("statistics") or {}
        have, want = st.get("episodeFileCount", 0), st.get("episodeCount", 0)
        if want and have >= want:
            status = "available"
        elif have:
            status = "partial"
        elif lib.get("monitored"):
            status = "processing"
        progress = safe(lambda: _queue("sonarr"), {}).get(lib["id"])
    by_num = {x["seasonNumber"]: x for x in (lib or {}).get("seasons", [])}
    for x in s.get("seasons", []):
        n = x["seasonNumber"]
        if n == 0:
            continue
        ls = (by_num.get(n) or {}).get("statistics") or {}
        seasons.append({"n": n, "episodes": ls.get("totalEpisodeCount") or (x.get("statistics") or {}).get("totalEpisodeCount"),
                        "have": ls.get("episodeFileCount", 0), "monitored": bool((by_num.get(n) or {}).get("monitored"))})
    src = lib or s
    return {
        "type": "tv", "id": s.get("tvdbId"), "tvdb": s.get("tvdbId"), "tmdb": s.get("tmdbId") or None,
        "imdb": s.get("imdbId"), "title": s.get("title"), "year": s.get("year") or None,
        "overview": s.get("overview"), "network": s.get("network"), "ended": s.get("ended"),
        "poster": _img(src.get("images"), "poster", s.get("remotePoster")),
        "backdrop": _img(src.get("images"), "fanart"),
        "runtime": s.get("runtime") or None, "genres": s.get("genres", [])[:3],
        "certification": s.get("certification"),
        "rating": (s.get("ratings") or {}).get("value") or None,
        "seasons": seasons, "status": status, "progress": progress,
        "status4k": state("tv", s.get("tvdbId"), True)[0],
    }


# ---------- lookup ----------
def search(term, kind=None):
    jobs = {}
    if kind in (None, "movie"):
        jobs["movie"] = _pool.submit(lambda: call("radarr", "GET", "/api/v3/movie/lookup", params={"term": term}))
    if kind in (None, "tv"):
        jobs["tv"] = _pool.submit(lambda: call("sonarr", "GET", "/api/v3/series/lookup", params={"term": term}))
    movies, shows, errors = [], [], []
    for k, fut in jobs.items():
        try:
            res = fut.result()[:20]
        except ArrError as e:
            errors.append(str(e))
            continue
        if k == "movie":
            movies = [shape_movie(m) for m in res if m.get("tmdbId")]
        else:
            shows = [shape_series(s) for s in res if s.get("tvdbId")]
    # interleave so the best movie and best show both land near the top; exact title matches first
    out, t = [], term.strip().lower()
    for i in range(max(len(movies), len(shows))):
        out += movies[i:i + 1] + shows[i:i + 1]
    out.sort(key=lambda x: (x["title"] or "").lower() != t)
    if not out and errors:
        raise ArrError(errors[0])
    return out


def lookup_movie(tmdb, srv="radarr"):
    lib = movie_lib(srv).get(tmdb)
    if lib:
        return lib
    r = call(srv, "GET", "/api/v3/movie/lookup/tmdb", params={"tmdbId": tmdb})
    if not r:
        raise ArrError("Movie not found.")
    return r


def lookup_series(tvdb, srv="sonarr"):
    lib = tv_lib(srv).get(tvdb)
    if lib:
        return lib
    r = call(srv, "GET", "/api/v3/series/lookup", params={"term": f"tvdb:{tvdb}"})
    if not r:
        raise ArrError("Show not found.")
    return r[0]


def item(kind, ext_id):
    return shape_movie(lookup_movie(ext_id)) if kind == "movie" else shape_series(lookup_series(ext_id))


# ---------- adding ----------
def add_movie(tmdb, search=True, is4k=False, profile=None, root=None):
    """profile/root override the server's defaults (admins can pick them per request)."""
    srv = srv_for("movie", is4k)
    c = _cfg(srv)
    lib = movie_lib(srv).get(tmdb)
    if lib:
        m = call(srv, "GET", f"/api/v3/movie/{lib['id']}")
        if not m["monitored"] or (profile and m["qualityProfileId"] != int(profile)):
            m["monitored"] = True
            if profile:
                m["qualityProfileId"] = int(profile)
            call(srv, "PUT", f"/api/v3/movie/{m['id']}", json=m)
        if search:
            call(srv, "POST", "/api/v3/command", json={"name": "MoviesSearch", "movieIds": [m["id"]]})
        mid = m["id"]
    else:
        m = lookup_movie(tmdb, srv)
        m.update({"qualityProfileId": int(profile or c["profile"]), "rootFolderPath": root or c["root"], "monitored": True,
                  "minimumAvailability": c["availability"], "addOptions": {"searchForMovie": search}})
        mid = call(srv, "POST", "/api/v3/movie", json=m)["id"]
    invalidate("movies")
    return mid


def add_series(tvdb, seasons=None, search=True, is4k=False, profile=None, root=None):
    """seasons: list of season numbers, or None for every season (specials excluded)."""
    srv = srv_for("tv", is4k)
    c = _cfg(srv)
    want = (lambda n: n > 0) if not seasons else (lambda n: n in seasons)
    lib = tv_lib(srv).get(tvdb)
    if lib:
        s = call(srv, "GET", f"/api/v3/series/{lib['id']}")
        for se in s["seasons"]:
            if want(se["seasonNumber"]):
                se["monitored"] = True
        s["monitored"] = True
        if profile:
            s["qualityProfileId"] = int(profile)
        call(srv, "PUT", f"/api/v3/series/{s['id']}", json=s)
        if search:
            if seasons:
                for n in seasons:
                    call(srv, "POST", "/api/v3/command", json={"name": "SeasonSearch", "seriesId": s["id"], "seasonNumber": n})
            else:
                call(srv, "POST", "/api/v3/command", json={"name": "SeriesSearch", "seriesId": s["id"]})
        sid = s["id"]
    else:
        s = lookup_series(tvdb, srv)
        for se in s.get("seasons", []):
            se["monitored"] = want(se["seasonNumber"])
        s.update({"qualityProfileId": int(profile or c["profile"]), "rootFolderPath": root or c["root"], "monitored": True,
                  "seasonFolder": bool(c["season_folders"]),
                  "addOptions": {"searchForMissingEpisodes": search, "ignoreEpisodesWithFiles": False}})
        sid = call(srv, "POST", "/api/v3/series", json=s)["id"]
    invalidate("series")
    return sid


def season_episodes(tvdb, n):
    """Episodes of one season from Sonarr, or None if the show isn't in Sonarr yet."""
    lib = safe(tv_lib, {}).get(tvdb)
    if not lib:
        return None
    eps = call("sonarr", "GET", "/api/v3/episode", params={"seriesId": lib["id"], "seasonNumber": n})
    return [{"n": e["episodeNumber"], "title": e.get("title"), "air_date": e.get("airDate"), "overview": e.get("overview"),
             "have": bool(e.get("hasFile")), "monitored": bool(e.get("monitored"))}
            for e in sorted(eps, key=lambda e: e["episodeNumber"]) if e["seasonNumber"] == n]


def add_episodes(tvdb, season, numbers, search=True, is4k=False, profile=None, root=None):
    """Just these episodes: add the show with nothing monitored if it's new, then monitor and search the episodes."""
    srv = srv_for("tv", is4k)
    c = _cfg(srv)
    lib = tv_lib(srv).get(tvdb)
    if lib:
        sid = lib["id"]
        if not lib.get("monitored"):
            s = call(srv, "GET", f"/api/v3/series/{sid}")
            s["monitored"] = True
            call(srv, "PUT", f"/api/v3/series/{sid}", json=s)
    else:
        s = lookup_series(tvdb, srv)
        for se in s.get("seasons", []):
            se["monitored"] = False
        s.update({"qualityProfileId": int(profile or c["profile"]), "rootFolderPath": root or c["root"], "monitored": True,
                  "seasonFolder": bool(c["season_folders"]),
                  "addOptions": {"monitor": "none", "searchForMissingEpisodes": False, "ignoreEpisodesWithFiles": False}})
        sid = call(srv, "POST", "/api/v3/series", json=s)["id"]
    invalidate("series")
    eps = []
    for _ in range(15):  # a show that was just added needs a moment while Sonarr fetches its episode list
        eps = [e for e in call(srv, "GET", "/api/v3/episode", params={"seriesId": sid, "seasonNumber": season})
               if e["episodeNumber"] in numbers]
        if eps:
            break
        time.sleep(1)
    if not eps:
        raise ArrError(f"{NAMES[srv]} doesn't have those episodes listed yet. Try again in a minute.")
    ids = [e["id"] for e in eps]
    call(srv, "PUT", "/api/v3/episode/monitor", json={"episodeIds": ids, "monitored": True})
    if search:
        call(srv, "POST", "/api/v3/command", json={"name": "EpisodeSearch", "episodeIds": ids})
    return sid


def fulfilled(kind, ext_id, seasons=None, episodes=None, is4k=False):
    """True once everything a request asked for has files (aired episodes only, for whole shows)."""
    srv = srv_for(kind, is4k)
    if kind == "movie":
        lib = movie_lib(srv).get(ext_id)
        return bool(lib and lib.get("hasFile"))
    lib = tv_lib(srv).get(ext_id)
    if not lib:
        return False
    if episodes:
        eps = call(srv, "GET", "/api/v3/episode", params={"seriesId": lib["id"], "seasonNumber": seasons[0]})
        return set(episodes) <= {e["episodeNumber"] for e in eps if e.get("hasFile")}
    by = {x["seasonNumber"]: x.get("statistics") or {} for x in lib.get("seasons", [])}
    want = seasons or [n for n, st in by.items() if n > 0 and st.get("episodeCount", 0)]
    return bool(want) and all(by.get(n, {}).get("episodeCount", 0) and
                              by[n].get("episodeFileCount", 0) >= by[n]["episodeCount"] for n in want)


# ---------- home rows ----------
def recent(kind, limit=20):
    def load():
        app = "radarr" if kind == "movie" else "sonarr"
        extra = {"includeMovie": "true"} if kind == "movie" else {"includeSeries": "true"}
        recs = call(app, "GET", "/api/v3/history", params={"pageSize": 400, "sortKey": "date", "sortDirection": "descending",
                                                           "eventType": 3, **extra})["records"]
        seen, out = set(), []
        for r in recs:
            obj = r.get("movie") if kind == "movie" else r.get("series")
            key = obj and (obj.get("tmdbId") if kind == "movie" else obj.get("tvdbId"))
            if not key or key in seen:
                continue
            seen.add(key)
            out.append((shape_movie if kind == "movie" else shape_series)(obj) | {"added": r.get("date")})
            if len(out) >= 60:
                break
        return out
    return cached("recent:" + kind, 300, load)[:limit]


def options(kind, conn=None):
    """Quality profiles + root folders, for the admin settings screen. conn = {url, key} to try unsaved ones."""
    return {"profiles": [{"id": p["id"], "name": p["name"]} for p in call(kind, "GET", "/api/v3/qualityprofile", conn)],
            "roots": [r["path"] for r in call(kind, "GET", "/api/v3/rootfolder", conn)]}


def test(kind, url, key):
    try:
        r = _http.get(url.rstrip("/") + "/api/v3/system/status", headers={"X-Api-Key": key})
    except httpx.HTTPError:
        return False, "Not reachable"
    if r.status_code != 200:
        return False, f"Answered {r.status_code}"
    return True, f"{r.json().get('appName', kind)} {r.json().get('version', '')}".strip()
