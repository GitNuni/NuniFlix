"""Shelves: permanent themed tiles, like a video store's aisles (Kids, Christmas, Halloween, Horror, Thanksgiving,
Valentine's, Summer, Snow Days). Each has its own pixel-art tile (web/shelves/<key>.png) and opens a page of rows.

They're always there; the ones in season (Christmas from mid-November, Halloween from mid-September...) move to the
front and say so. A shelf page starts with what's ready to watch: the person's own Plex/Jellyfin for shelves that map
to a library genre (Kids, Horror), then anything on the shelf that's already on the server, then TMDB rows
(keyword searches, looked up by name once and remembered, the same as the seasonal horror channel).
"""
import datetime, os

import arr, tmdb
from seasonal import _keyword

US_KIDS = {"certification_country": "US", "certification.lte": "PG"}

# key: (title, tagline, season window ((month, day), (month, day)) or None for all year, library genres, rows)
# row: (title, kind, params); "kw" in params is a list of TMDB keyword names (any of them)
SHELVES = {
    "kids": ("Kids", "Cartoons, family films and Saturday-morning TV", None, ["Kids", "Children", "Family", "Animation"], [
        ("Animated favourites", "movie", {"with_genres": "16", **US_KIDS}),
        ("Family movie night", "movie", {"with_genres": "10751", **US_KIDS}),
        ("Kids' TV", "tv", {"with_genres": "10762"}),
        ("Short ones (under 90 minutes)", "movie", {"with_genres": "16|10751", "with_runtime.lte": 90, **US_KIDS}),
        ("Family classics", "movie", {"with_genres": "10751", "sort_by": "vote_average.desc", "vote_count.gte": 3000, **US_KIDS}),
    ]),
    "christmas": ("Christmas", "Lights, snow and at least one Die Hard argument", ((11, 15), (1, 6)), ["Christmas", "Holiday"], [
        ("Christmas classics", "movie", {"kw": ["christmas"], "sort_by": "vote_average.desc", "vote_count.gte": 800}),
        ("Christmas comedies", "movie", {"kw": ["christmas"], "with_genres": "35"}),
        ("Animated Christmas", "movie", {"kw": ["christmas"], "with_genres": "16"}),
        ("Christmas romance", "movie", {"kw": ["christmas"], "with_genres": "10749"}),
        ("Christmas action", "movie", {"kw": ["christmas"], "with_genres": "28"}),
        ("Christmas horror", "movie", {"kw": ["christmas"], "with_genres": "27"}),
    ]),
    "halloween": ("Halloween", "Pumpkins, haunted houses and a few safe scares", ((9, 15), (10, 31)), [], [
        ("Halloween night", "movie", {"kw": ["halloween"], "with_genres": "27"}),
        ("Not too scary", "movie", {"kw": ["halloween", "witch", "haunted house"], "with_genres": "10751|16", "without_genres": "27"}),
        ("Haunted houses", "movie", {"kw": ["haunted house"], "with_genres": "27"}),
        ("Witches", "movie", {"kw": ["witch"]}),
        ("Monster classics", "movie", {"kw": ["monster"], "with_genres": "27", "sort_by": "vote_average.desc", "vote_count.gte": 1000}),
    ]),
    "horror": ("Horror", "Lights off. All year round.", None, ["Horror"], [
        ("Popular horror", "movie", {"with_genres": "27"}),
        ("Slashers", "movie", {"kw": ["slasher"], "with_genres": "27"}),
        ("Supernatural", "movie", {"kw": ["supernatural", "possession"], "with_genres": "27"}),
        ("Creature features", "movie", {"kw": ["creature", "monster"], "with_genres": "27"}),
        ("Zombies", "movie", {"kw": ["zombie"], "with_genres": "27"}),
        ("All-time horror classics", "movie", {"with_genres": "27", "sort_by": "vote_average.desc", "vote_count.gte": 2000}),
    ]),
    "thanksgiving": ("Thanksgiving", "Big tables, bigger families", ((11, 1), (11, 30)), [], [
        ("Thanksgiving", "movie", {"kw": ["thanksgiving"]}),
        ("Family get-togethers", "movie", {"kw": ["family reunion", "family holiday", "dysfunctional family"], "with_genres": "35"}),
        ("Food on film", "movie", {"kw": ["cooking", "chef", "restaurant"]}),
        ("Big family comedies", "movie", {"with_genres": "35,10751", "sort_by": "vote_average.desc", "vote_count.gte": 1500}),
    ]),
    "valentines": ("Valentine's", "Rom-coms, weepies and great love stories", ((2, 1), (2, 14)), ["Romance"], [
        ("Rom-coms", "movie", {"with_genres": "10749,35"}),
        ("Great love stories", "movie", {"with_genres": "10749", "sort_by": "vote_average.desc", "vote_count.gte": 2000}),
        ("Bring tissues", "movie", {"with_genres": "10749,18", "sort_by": "vote_average.desc", "vote_count.gte": 800}),
        ("Valentine's Day", "movie", {"kw": ["valentine's day"]}),
    ]),
    "summer": ("Summer", "Beaches, road trips and long nights at camp", ((6, 1), (8, 31)), [], [
        ("Summer vacation", "movie", {"kw": ["summer vacation", "summer"]}),
        ("Beach days", "movie", {"kw": ["beach"]}),
        ("Road trips", "movie", {"kw": ["road trip"]}),
        ("Summer camp", "movie", {"kw": ["summer camp"]}),
        ("Blockbusters", "movie", {"with_genres": "28|12", "sort_by": "revenue.desc"}),
    ]),
    "winter": ("Snow Days", "Blankets, cocoa and something snowy", ((1, 7), (2, 28)), [], [
        ("Snowed in", "movie", {"kw": ["snow", "blizzard"]}),
        ("On the slopes", "movie", {"kw": ["skiing", "snowboarding"]}),
        ("On the ice", "movie", {"kw": ["ice skating", "ice hockey"]}),
        ("Cozy winter romance", "movie", {"kw": ["snow", "winter"], "with_genres": "10749"}),
    ]),
}
WEB = os.path.join(os.path.dirname(__file__), "web")


def _in(window, d):
    if not window:
        return False
    (m1, d1), (m2, d2) = window
    a, b, x = (m1, d1), (m2, d2), (d.month, d.day)
    return a <= x <= b if a <= b else (x >= a or x <= b)  # Christmas wraps round New Year


def _days_until(window, d):
    """Days until the window next opens (0 when it's open)."""
    if _in(window, d):
        return 0
    m, day = window[0]
    start = datetime.date(d.year, m, day)
    if start < d:
        start = datetime.date(d.year + 1, m, day)
    return (start - d).days


def listing(d=None):
    """Every shelf, in season first, then the all-year ones (Kids, Horror), then the rest by how soon they come round."""
    d = d or datetime.date.today()

    def order(item):
        k, (_, _, window, _, _) = item
        if _in(window, d):
            return (0, 0)
        return (1, 0) if window is None else (2, _days_until(window, d))
    out = []
    for k, (title, tagline, window, _, _) in sorted(SHELVES.items(), key=order):
        out.append({"key": k, "title": title, "tagline": tagline, "art": f"/shelves/{k}.png",
                    "now": _in(window, d), "all_year": window is None})
    return out


def _discover(kind, params):
    q = {"include_adult": "false", "sort_by": "popularity.desc", "vote_count.gte": 40 if kind == "movie" else 20, **params}
    words = q.pop("kw", None)
    if words:
        ids = [str(k) for k in (_keyword(w) for w in words) if k]
        if not ids:
            return []
        q["with_keywords"] = "|".join(ids)
    key = f"tmdb:shelf:{kind}:" + ":".join(f"{k}={v}" for k, v in sorted(q.items()))
    data = arr.cached(key, 6 * 3600, lambda: tmdb.get(f"/discover/{kind}", **q))
    return tmdb.shape(data.get("results", []), kind, resolve=False)


def _library(user, genres):
    """What's on the person's own server in the first of these genres it has (merged when it has a few)."""
    if user is None or not genres:
        return None, []
    try:
        import library
        name = library.store.SOURCES[library._src(user)[0]]
        items, seen = [], set()
        for g in genres:
            for x in library._list(user, "all", g, 1):
                k = (x["type"], x.get("tmdb") or x.get("id"))
                if k not in seen:
                    seen.add(k)
                    items.append(x)
        return name, items
    except Exception:  # no Plex/Jellyfin linked, or it's unreachable: the TMDB rows still work
        return None, []


def page(key, user=None):
    title, tagline, window, genres, spec = SHELVES[key]
    tm = []
    if tmdb.key():
        for i, (rtitle, kind, params) in enumerate(spec):
            try:
                tm.append({"key": f"r{i}", "title": rtitle, "type": kind, "items": _discover(kind, params)})
            except Exception:  # one row failing (TMDB hiccup) shouldn't take the shelf down
                continue
    rows = []
    name, mine = _library(user, genres)
    if len(mine) >= 4:
        rows.append({"key": "server", "title": f"{title} on {name}", "type": "all", "items": mine[:30]})
    ready = [x for r in tm for x in r["items"] if x.get("status") == "available"]
    if len(ready) >= 3:  # already on the server, pulled out of the rows below
        rows.append({"key": "ready", "title": "Ready to watch", "type": "all", "items": ready})
    rows += tm
    seen, out = set(), []
    for r in rows:  # each title once, in its first row
        items = []
        for x in r["items"]:
            k = (x["type"], x.get("tmdb") or x.get("id"))
            if k not in seen:
                seen.add(k)
                items.append(x)
        if len(items) >= 4:
            out.append({**r, "sort": "popular", "cat": None, "items": items[:20]})
    hero = next((x for r in out for x in r["items"] if x.get("backdrop") and x.get("overview")), None)
    return {"key": key, "title": title, "tagline": tagline, "art": f"/shelves/{key}.png",
            "now": _in(window, datetime.date.today()), "hero": hero, "rows": out}
