"""TMDB: what each streaming service carries (watch-provider data from JustWatch), trending, TMDB→TVDB ids.

Needs a free TMDB key (v3 "API Key" or v4 "Read Access Token") in config tmdb.key.
Movies keep their TMDB id; shows are converted to TVDB ids because that's what Sonarr requests use.
"""
import datetime, re
from concurrent.futures import ThreadPoolExecutor

import httpx

import arr, store

API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p/"
_http = httpx.Client(timeout=15)
_pool = ThreadPoolExecutor(8)
_tvdb = {}  # tmdb tv id -> tvdb id (never changes, so cached forever)
# add-on channels and ad tiers that would just duplicate the main services
HIDE = ("with ads", "amazon channel", "apple tv channel", "roku premium channel", "free with")
# US subscription services, in tile order. Several TMDB ids = tiers of one brand, merged into one tile
# (TMDB treats "386|387" as either). Other regions fall back to TMDB's own ordering.
SERVICES = {"US": [
    ("Netflix", "8"), ("HBO Max", "1899"), ("Disney+", "337"), ("Hulu", "15"), ("Prime Video", "9"),
    ("Apple TV", "350"), ("Peacock", "386|387"), ("Paramount+", "2303|2616"), ("Crunchyroll", "283"),
    ("Starz", "43"), ("MGM+", "34"), ("AMC+", "526"), ("Shudder", "99"), ("Criterion Channel", "258"),
    ("BritBox", "151"), ("Discovery+", "520"),
]}


class TmdbError(arr.ArrError):
    pass


def key():
    return store.config()["tmdb"]["key"]


def region():
    return store.config()["tmdb"]["region"] or "US"


def get(path, k=None, **params):
    k = k or key()
    if not k:
        raise TmdbError("Add a TMDB key in You → Settings to browse streaming services.")
    headers = {"Accept": "application/json"}
    if k.startswith("eyJ"):  # v4 read access token
        headers["Authorization"] = "Bearer " + k
    else:
        params["api_key"] = k
    try:
        r = _http.get(API + path, params=params, headers=headers)
    except httpx.HTTPError:
        raise TmdbError("TMDB isn't reachable right now.")
    if r.status_code == 401:
        raise TmdbError("TMDB didn't accept the key.")
    if r.status_code >= 400:
        raise TmdbError(f"TMDB answered {r.status_code}.")
    return r.json()


def test(k):
    try:
        get("/configuration", k)
        return True, "Connected"
    except TmdbError as e:
        return False, str(e)


def _logo(path, size="w154"):
    return IMG + size + path if path else None


def providers(limit=18):
    """The main subscription services in this region, most popular first."""
    reg = region()

    def load():
        merged = {}
        for kind in ("movie", "tv"):
            for p in get(f"/watch/providers/{kind}", watch_region=reg)["results"]:
                name = p["provider_name"]
                if any(h in name.lower() for h in HIDE):
                    continue
                prio = (p.get("display_priorities") or {}).get(reg, p.get("display_priority", 999))
                cur = merged.get(str(p["provider_id"]))
                if not cur or prio < cur["priority"]:
                    merged[str(p["provider_id"])] = {"id": str(p["provider_id"]), "name": name,
                                                     "logo": _logo(p.get("logo_path")), "priority": prio}
        if reg in SERVICES:
            return [{"id": ids, "name": name, "logo": merged[ids.split("|")[0]]["logo"]}
                    for name, ids in SERVICES[reg] if ids.split("|")[0] in merged]
        return sorted(merged.values(), key=lambda p: p["priority"])[:limit]
    return arr.cached("tmdb:providers:" + reg, 86400, load)


# TV networks whose shows are the service's own ("Originals"). Keyed by tile id.
ORIGINALS = {"8": "213", "1899": "49|3186", "337": "2739", "15": "453", "9": "1024", "350": "2552",
             "386|387": "3353", "2303|2616": "4330", "283": "1112", "43": "318", "34": "6219|922",
             "526": "4661|174", "520": "4353"}
# Category rows, like each service's own home screen: (key, title, extra discover params)
GENRES = {
    "movie": [("action", "Action", {"with_genres": "28"}), ("comedy", "Comedy", {"with_genres": "35"}),
              ("drama", "Drama", {"with_genres": "18"}), ("scifi", "Sci-Fi", {"with_genres": "878"}),
              ("horror", "Horror", {"with_genres": "27"}), ("thriller", "Thrillers", {"with_genres": "53"}),
              ("romance", "Romance", {"with_genres": "10749"}), ("crime", "Crime", {"with_genres": "80"}),
              ("animation", "Animation", {"with_genres": "16"}), ("family", "Family", {"with_genres": "10751"}),
              ("docs", "Documentaries", {"with_genres": "99"})],
    "tv": [("action", "Action & Adventure", {"with_genres": "10759"}), ("comedy", "Comedy", {"with_genres": "35"}),
           ("drama", "Drama", {"with_genres": "18"}), ("scifi", "Sci-Fi & Fantasy", {"with_genres": "10765"}),
           ("crime", "Crime", {"with_genres": "80"}), ("mystery", "Mystery", {"with_genres": "9648"}),
           ("anime", "Anime", {"with_genres": "16", "with_original_language": "ja"}),
           ("animation", "Animation", {"with_genres": "16"}), ("reality", "Reality", {"with_genres": "10764"}),
           ("docs", "Docuseries", {"with_genres": "99"}), ("kids", "Kids", {"with_genres": "10762"})],
}


def group_of(provider_id):
    """Which tile a single TMDB provider id belongs to: (tile id, tile name) or None."""
    for name, ids in SERVICES.get(region(), []):
        if str(provider_id) in ids.split("|"):
            return ids, name
    return None


def _lib_tvdb():
    """tmdb id -> tvdb id for shows already in Sonarr."""
    return arr.cached("tv_by_tmdb", 60, lambda: {s["tmdbId"]: s["tvdbId"] for s in arr.safe(arr.tv_lib, {}).values()
                                                  if s.get("tmdbId")})


def tvdb_id(tmdb):
    if tmdb in _tvdb:
        return _tvdb[tmdb]
    if tmdb in _lib_tvdb():
        _tvdb[tmdb] = _lib_tvdb()[tmdb]
        return _tvdb[tmdb]
    try:
        val = get(f"/tv/{tmdb}/external_ids").get("tvdb_id")
    except TmdbError:
        return None
    if val:  # brand-new shows often get their TVDB id a few days later, so don't remember "none"
        _tvdb[tmdb] = val
    return val


def _year(d):
    return int(d[:4]) if d and d[:4].isdigit() else None


GENRE_NAMES = {28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
               10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
               878: "Sci-Fi", 53: "Thriller", 10752: "War", 37: "Western", 10759: "Action & Adventure", 10762: "Kids",
               10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10768: "War & Politics"}


def shape(results, kind=None, resolve=True):
    """TMDB list results -> NuniFlix tiles.
    resolve=True looks up every show's TVDB id now (shows without one are dropped: Sonarr can't add them).
    resolve=False is for quick rows: unknown shows get id None and are resolved when tapped (/api/item/tvtmdb/...)."""
    rows = [(kind or x.get("media_type"), x) for x in results]
    rows = [(k, x) for k, x in rows if k in ("movie", "tv")]
    if resolve:
        list(_pool.map(tvdb_id, [x["id"] for k, x in rows if k == "tv"]))
    lib = _lib_tvdb()
    out = []
    for k, x in rows:
        ext = x["id"] if k == "movie" else (_tvdb.get(x["id"]) or lib.get(x["id"]))
        if not ext and resolve:
            continue
        status, progress = arr.state(k, ext) if ext else ("none", None)
        out.append({"type": k, "id": ext, "tmdb": x["id"], "title": x.get("title") or x.get("name"),
                    "year": _year(x.get("release_date") or x.get("first_air_date")),
                    "poster": _logo(x.get("poster_path"), "w342"), "backdrop": _logo(x.get("backdrop_path"), "w1280"),
                    "overview": x.get("overview"), "rating": x.get("vote_average") or None,
                    "genres": [GENRE_NAMES[g] for g in x.get("genre_ids") or [] if g in GENRE_NAMES][:3],
                    "status": status, "progress": progress})
    return out


def discover(provider, kind="movie", sort="popular", page=1, cat=None, resolve=True, extra=None):
    """One page of what a service carries. extra: discover params to use instead of looking `cat` up in GENRES
    (the mixed genres pass their own; `cat` then only keeps the cache key apart)."""
    reg, today = region(), datetime.date.today().isoformat()
    date = "primary_release_date" if kind == "movie" else "first_air_date"
    params = {"with_watch_providers": provider, "watch_region": reg, "with_watch_monetization_types": "flatrate",
              "include_adult": "false", "page": page, "sort_by": "popularity.desc"}
    if cat == "originals":
        if kind != "tv" or provider not in ORIGINALS:
            raise TmdbError("No originals for that.")
        params = {"with_networks": ORIGINALS[provider], "include_adult": "false", "page": page, "sort_by": "popularity.desc"}
    elif extra is not None:
        params.update(extra)
    elif cat:
        extra = next((g[2] for g in GENRES[kind] if g[0] == cat), None)
        if extra is None:  # a combined-page genre (MIXED_GENRES), asked for one kind: its movie or show half
            mg = next((g for g in MIXED_GENRES if g[0] == cat), None)
            extra = (mg[2] if kind == "movie" else mg[3]) if mg else None
        if extra is None:
            raise TmdbError("Unknown category.")
        params.update(extra)
    if sort == "new":
        params.update({"sort_by": f"{date}.desc", f"{date}.lte": today, "vote_count.gte": 5})
    elif sort == "top":
        params.update({"sort_by": "vote_average.desc", "vote_count.gte": 300})

    def load():
        d = get(f"/discover/{kind}", **params)
        return {"results": d.get("results", []), "page": d.get("page", page), "total_pages": min(d.get("total_pages", 1), 500)}
    d = arr.cached(f"tmdb:disc:{reg}:{provider}:{kind}:{sort}:{cat}:{page}", 3600, load)
    return {"results": shape(d["results"], kind, resolve), "page": d["page"], "total_pages": d["total_pages"]}


_rows_pool = ThreadPoolExecutor(6)

# Genres for the combined (movies + shows) service pages: (key, title, movie params | None, show params | None).
# TMDB's show genres differ a little from its movie ones (no Horror or Thriller for shows, combined Sci-Fi & Fantasy).
MIXED_GENRES = [
    ("action", "Action & Adventure", {"with_genres": "28"}, {"with_genres": "10759"}),
    ("comedy", "Comedy", {"with_genres": "35"}, {"with_genres": "35"}),
    ("drama", "Drama", {"with_genres": "18"}, {"with_genres": "18"}),
    ("scifi", "Sci-Fi & Fantasy", {"with_genres": "878|14"}, {"with_genres": "10765"}),
    ("crime", "Crime", {"with_genres": "80"}, {"with_genres": "80"}),
    ("thriller", "Thrillers", {"with_genres": "53"}, None),
    ("horror", "Horror", {"with_genres": "27"}, None),
    ("mystery", "Mystery", {"with_genres": "9648"}, {"with_genres": "9648"}),
    ("romance", "Romance", {"with_genres": "10749"}, None),
    ("animation", "Animation", {"with_genres": "16"}, {"with_genres": "16"}),
    ("anime", "Anime", {"with_genres": "16", "with_original_language": "ja"}, {"with_genres": "16", "with_original_language": "ja"}),
    ("family", "Family", {"with_genres": "10751"}, {"with_genres": "10751"}),
    ("kids", "Kids", None, {"with_genres": "10762"}),
    ("docs", "Documentaries", {"with_genres": "99"}, {"with_genres": "99"}),
    ("reality", "Reality", None, {"with_genres": "10764"}),
]


def _interleave(a, b):
    out = []
    for i in range(max(len(a), len(b))):
        out += a[i:i + 1] + b[i:i + 1]
    return out


def discover_all(provider, sort="popular", page=1, cat=None, resolve=False):
    """Movies and shows together, alternating, like the service's own home screen. cat: a MIXED_GENRES key."""
    g = next((x for x in MIXED_GENRES if x[0] == cat), None) if cat else None
    if cat and not g:
        raise TmdbError("Unknown category.")
    parts = []
    for kind, extra in (("movie", g[2] if g else None), ("tv", g[3] if g else None)):
        if g and extra is None:  # e.g. Horror: TMDB has no show genre for it
            parts.append({"results": [], "page": page, "total_pages": 0})
        else:  # one after the other, not in _rows_pool: rows_all() already runs in it, and waiting on it from inside could deadlock
            parts.append(discover(provider, kind, sort, page, f"mix-{cat}" if cat else None, resolve, extra))
    return {"results": _interleave(parts[0]["results"], parts[1]["results"]), "page": page,
            "total_pages": max(p["total_pages"] for p in parts)}


def rows_genre(provider, cat, name=""):
    """One genre on a service, laid out like a service page: popular / new / top rated (movies and shows together),
    then that genre's movies and its shows."""
    g = next((x for x in MIXED_GENRES if x[0] == cat), None)
    if not g:
        raise TmdbError("Unknown category.")
    _, title, movie_q, tv_q = g
    spec = [("popular", f"Popular {title.lower()}" if title[0].isupper() else title, "all", "popular"),
            ("new", "New releases", "all", "new"), ("top", "Top rated", "all", "top")]
    if movie_q:
        spec.append(("movies", "Movies", "movie", "popular"))
    if tv_q:
        spec.append(("shows", "Shows", "tv", "popular"))

    def one(row):
        key, rtitle, kind, sort = row
        try:
            items = (discover_all(provider, sort, 1, cat) if kind == "all" else discover(provider, kind, sort, 1, cat, resolve=False))["results"]
        except TmdbError:
            items = []
        return {"key": key, "title": rtitle, "type": kind, "sort": sort, "cat": cat, "items": items}
    out = [r for r in _rows_pool.map(one, spec) if len(r["items"]) >= 4]
    hero = next((x for r in out[:1] for x in r["items"] if x.get("backdrop") and x.get("overview")), None)
    return {"hero": hero, "rows": out}


def rows_all(provider, name=""):
    """A service's home screen with movies and shows together: mixed rows, then Movies and Shows rows, then genres."""
    spec = [("popular", f"Popular on {name}".strip() if name else "Popular", "all", "popular", None)]
    if provider in ORIGINALS:
        spec.append(("originals", f"{name} Originals".strip(), "tv", "popular", "originals"))
    spec += [("new", "New releases", "all", "new", None), ("top", "Top rated", "all", "top", None),
             ("movies", "Movies", "movie", "popular", None), ("shows", "Shows", "tv", "popular", None)]

    def one(row):
        key, title, kind, sort, cat = row
        try:
            items = (discover_all(provider, sort, 1, cat) if kind == "all" else discover(provider, kind, sort, 1, cat, resolve=False))["results"]
        except TmdbError:
            items = []
        return {"key": key, "title": title, "type": kind, "sort": sort, "cat": cat, "items": items}
    out = [r for r in _rows_pool.map(one, spec) if len(r["items"]) >= 6]
    pick = sorted(out[:2], key=lambda r: r["key"] != "originals")
    hero = next((x for r in pick for x in r["items"] if x.get("backdrop") and x.get("overview")), None)
    return {"hero": hero, "rows": out, "genres": [{"key": k, "title": t} for k, t, _, _ in MIXED_GENRES]}


def rows(provider, kind, name=""):
    """A service's home screen: featured title + category rows (first page each, thin ones dropped)."""
    spec = [("popular", "Popular", "popular", None)]
    if kind == "tv" and provider in ORIGINALS:
        spec.append(("originals", f"{name} Originals".strip(), "popular", "originals"))
    spec += [("new", "New releases", "new", None), ("top", "Top rated", "top", None)]
    spec += [(k, title, "popular", k) for k, title, _ in GENRES[kind]]

    def one(row):
        key, title, sort, cat = row
        try:
            items = discover(provider, kind, sort, 1, cat, resolve=False)["results"]
        except TmdbError:
            items = []
        return {"key": key, "title": title, "type": kind, "sort": sort, "cat": cat, "items": items}
    out = [r for r in _rows_pool.map(one, spec) if len(r["items"]) >= 6]
    # feature the service's own show when it has originals, like the real apps do
    pick = sorted(out[:2], key=lambda r: r["key"] != "originals")
    hero = next((x for r in pick for x in r["items"] if x.get("backdrop") and x.get("overview")), None)
    return {"hero": hero, "rows": out}


def search_on(provider, q, kind=None):
    """Titles matching q that this service carries (TMDB search, then each hit's watch providers)."""
    reg = region()

    def load():
        hits = []
        for page in (1, 2):
            d = get("/search/multi", query=q, page=page, include_adult="false")
            hits += [x for x in d.get("results", []) if x.get("media_type") in ("movie", "tv")]
            if page >= d.get("total_pages", 1):
                break
        seen = set()
        hits = [x for x in hits if (x["media_type"], x["id"]) not in seen and not seen.add((x["media_type"], x["id"]))]
        if kind:
            hits = [x for x in hits if x["media_type"] == kind]
        carried = list(_rows_pool.map(lambda x: any(p["id"] == provider for p in streaming_on(x["media_type"], x["id"])), hits))
        return [x for x, ok in zip(hits, carried) if ok]
    found = arr.cached(f"tmdb:son:{reg}:{provider}:{kind}:{q.lower()}", 900, load)
    return shape(found, resolve=False)


def season_episodes(tmdb_id, n):
    """Episode list from TMDB, for shows Sonarr doesn't have yet."""
    d = arr.cached(f"tmdb:season:{tmdb_id}:{n}", 86400, lambda: get(f"/tv/{tmdb_id}/season/{n}"))
    return [{"n": e["episode_number"], "title": e.get("name"), "air_date": e.get("air_date"), "overview": e.get("overview"),
             "have": False, "monitored": False} for e in d.get("episodes", [])]


def extras(kind, tmdb_id):
    """Trailer, cast, collection and recommendations for a detail page."""
    path, credits = (f"/movie/{tmdb_id}", "credits") if kind == "movie" else (f"/tv/{tmdb_id}", "aggregate_credits")
    d = arr.cached(f"tmdb:x2:{kind}:{tmdb_id}", 86400, lambda: get(path, append_to_response=f"videos,{credits},recommendations,images",
                                                                    include_image_language="en,null"))
    logos = (d.get("images") or {}).get("logos") or []
    logo = next((x for x in logos if x.get("iso_639_1") == "en"), None) or (logos[0] if logos else None)
    vids = [v for v in (d.get("videos") or {}).get("results", []) if v.get("site") == "YouTube"]
    trailer = (next((v for v in vids if v.get("type") == "Trailer" and v.get("official")), None)
               or next((v for v in vids if v.get("type") == "Trailer"), None) or (vids[0] if vids else None))
    cast = [{"id": c["id"], "name": c["name"], "photo": _logo(c.get("profile_path"), "w185"),
             "role": c.get("character") or ((c.get("roles") or [{}])[0].get("character"))}
            for c in (d.get(credits) or {}).get("cast", [])[:20]]
    collection = None
    if kind == "movie" and d.get("belongs_to_collection"):
        cid = d["belongs_to_collection"]["id"]
        col = arr.cached(f"tmdb:col:{cid}", 86400, lambda: get(f"/collection/{cid}"))
        parts = sorted(col.get("parts", []), key=lambda x: x.get("release_date") or "9999")
        collection = {"name": col.get("name"), "items": shape(parts, "movie", resolve=False)}
    return {"trailer": f"https://www.youtube.com/watch?v={trailer['key']}" if trailer else None,
            "cast": cast, "collection": collection, "logo": _logo(logo["file_path"], "w500") if logo else None,
            "recommendations": shape((d.get("recommendations") or {}).get("results", [])[:20], kind, resolve=False)}


def person(pid):
    d = arr.cached(f"tmdb:person:{pid}", 86400, lambda: get(f"/person/{pid}", append_to_response="combined_credits"))
    seen, picks = set(), []
    talk = {10767, 10763}  # skip talk-show and news guest spots
    for c in sorted((d.get("combined_credits") or {}).get("cast", []), key=lambda c: -(c.get("vote_count") or 0)):
        k = (c.get("media_type"), c["id"])
        if k in seen or c.get("media_type") not in ("movie", "tv") or talk & set(c.get("genre_ids") or []):
            continue
        if c["media_type"] == "tv" and (c.get("episode_count") or 0) < 3:  # one-off guest spots
            continue
        if re.search(r"\b(self|himself|herself|themselves)\b", c.get("character") or "", re.I):  # documentaries, cameos as themselves
            continue
        seen.add(k)
        picks.append(c)
    return {"id": d["id"], "name": d.get("name"), "photo": _logo(d.get("profile_path"), "h632"),
            "bio": d.get("biography"), "born": d.get("birthday"), "place": d.get("place_of_birth"),
            "known_for": d.get("known_for_department"), "credits": shape(picks[:60], resolve=False)}


def popular(kind, page=1):
    """Well-liked, popular titles for swipe mode (quick: shows resolve to TVDB when tapped)."""
    d = arr.cached(f"tmdb:pop:{region()}:{kind}:{page}", 3600, lambda: get(f"/discover/{kind}", sort_by="popularity.desc",
                   **{"vote_count.gte": 150, "page": page, "include_adult": "false"})["results"])
    return shape(d, kind, resolve=False)


# Home's browse rows: a few categories each day, so Home isn't the same every time (kind, title, discover params)
HOME_GENRES = {
    "movie": [("Action movies", {"with_genres": "28"}), ("Comedies", {"with_genres": "35"}), ("Sci-fi movies", {"with_genres": "878"}),
              ("Horror movies", {"with_genres": "27"}), ("Thrillers", {"with_genres": "53"}), ("Animated movies", {"with_genres": "16"}),
              ("Family movies", {"with_genres": "10751"}), ("Romantic movies", {"with_genres": "10749"}), ("Crime movies", {"with_genres": "80"}),
              ("Documentaries", {"with_genres": "99"})],
    "tv": [("Crime shows", {"with_genres": "80"}), ("Comedy shows", {"with_genres": "35"}), ("Sci-fi & fantasy shows", {"with_genres": "10765"}),
           ("Drama shows", {"with_genres": "18"}), ("Anime", {"with_genres": "16", "with_original_language": "ja"}),
           ("Docuseries", {"with_genres": "99"}), ("Reality shows", {"with_genres": "10764"})],
}


def home_rows():
    """Things to find on Home that may not be on the server yet: in theaters, coming soon, popular, and three categories."""
    reg, today = region(), datetime.date.today()

    def pages(name, path, n=1, **params):
        def load():
            out = []
            for p in range(1, n + 1):
                out += get(path, page=p, **params).get("results", [])
            return out
        return arr.safe(lambda: arr.cached(f"tmdb:home:{reg}:{name}", 3600, load), [])

    day = today.toordinal()
    mg, tg = HOME_GENRES["movie"], HOME_GENRES["tv"]
    picks = [("movie", *mg[day % len(mg)]), ("tv", *tg[day % len(tg)]), ("movie", *mg[(day + 3) % len(mg)])]
    base = {"include_adult": "false", "sort_by": "popularity.desc", "vote_count.gte": 80}
    spec = [("theaters", "In theaters", "movie", lambda: pages("now", "/movie/now_playing", 2, region=reg)),
            ("popular", "Popular movies", "movie", lambda: pages("popm", "/discover/movie", 2, **(base | {"vote_count.gte": 150}))),
            ("popular", "Popular shows", "tv", lambda: pages("popt", "/discover/tv", 2, **(base | {"vote_count.gte": 150}))),
            ("upcoming", "Coming to theaters", "movie", lambda: [x for x in pages("soon", "/movie/upcoming", 2, region=reg)
                                                                 if (x.get("release_date") or "") > today.isoformat()])]
    spec += [("genres", title, k, (lambda k=k, title=title, extra=extra: pages(f"g:{k}:{title}", f"/discover/{k}", 2, **base, **extra)))
             for k, title, extra in picks]
    raw = list(_rows_pool.map(lambda s: s[3](), spec))
    out = []
    for (key, title, kind, _), results in zip(spec, raw):
        items = shape(results, kind, resolve=False)
        if key == "upcoming":
            dates = {x["id"]: x.get("release_date") for x in results}
            items.sort(key=lambda it: dates.get(it["tmdb"]) or "")
            for it in items:  # shown under the poster instead of the year
                d = dates.get(it["tmdb"])
                if d:
                    dd = datetime.date.fromisoformat(d)
                    it["network"] = f"{dd:%b} {dd.day}"
        out.append({"key": key, "title": title, "items": items})
    return out


def trending_quick():
    d = arr.cached("tmdb:trending", 3600, lambda: get("/trending/all/week")["results"])
    return shape(d, resolve=False)


def trending():
    d = arr.cached("tmdb:trending", 3600, lambda: get("/trending/all/week")["results"])
    return shape(d)


def streaming_on(kind, tmdb):
    """Subscription services carrying this title in this region: [{id, name, logo}]."""
    if not tmdb or not key():
        return []
    reg = region()

    def load():
        res = get(f"/{kind}/{tmdb}/watch/providers").get("results", {}).get(reg, {})
        out, seen = [], set()
        for p in res.get("flatrate", []):
            if any(h in p["provider_name"].lower() for h in HIDE):
                continue
            grp = group_of(p["provider_id"])
            if not grp and reg in SERVICES:  # skip cable/live-TV channels that have no tile
                continue
            gid, name = grp or (str(p["provider_id"]), p["provider_name"])
            if gid not in seen:
                seen.add(gid)
                out.append({"id": gid, "name": name, "logo": _logo(p.get("logo_path"), "w92")})
        return out
    return arr.safe(lambda: arr.cached(f"tmdb:wp2:{reg}:{kind}:{tmdb}", 86400, load), [])
