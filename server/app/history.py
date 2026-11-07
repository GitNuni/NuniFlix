"""What each person has actually watched: Plex server history, or Jellyfin's played items.

Powers "Because you watched…" rows, requesting the next season when someone finishes one, and Wrapped.
Only ever shown to the person themselves.
"""
import calendar, datetime, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import httpx

import arr, store, tmdb

_http = httpx.Client(timeout=20, headers={"Accept": "application/json"})
_pool = ThreadPoolExecutor(6)


def _plex():
    c = store.config()["plex"]
    return (c["url"].rstrip("/"), {"X-Plex-Token": c["token"]}) if c["url"] and c.get("token") else None


def _jf():
    c = store.config()["jellyfin"]
    return (c["url"].rstrip("/"), {"Authorization": f'MediaBrowser Token="{c["key"]}"'}) if c["url"] and c["key"] else None


# ---------- plays ----------
def plays(user_id, limit=500):
    """Newest first: [{type: movie|episode, title, show, season, episode, at, key, show_key, src}]."""
    out = []
    for ident in store.identities(user_id):
        try:
            if ident["source"] == "plex" and _plex():
                out += _plex_plays(1 if ident["owner"] else int(ident["id"].split(":")[1]), limit)
            elif ident["source"] == "jellyfin" and _jf():
                out += _jf_plays(ident["id"][3:], limit)
        except (httpx.HTTPError, ValueError, KeyError):
            pass
    return sorted(out, key=lambda p: -p["at"])


def _plex_plays(account, limit):
    base, h = _plex()

    def load():
        mc = _http.get(base + "/status/sessions/history/all", headers=h,
                       params={"sort": "viewedAt:desc", "accountID": account, "X-Plex-Container-Size": limit}).json()["MediaContainer"]
        return [{"type": m["type"], "title": m.get("title"), "show": m.get("grandparentTitle"), "season": m.get("parentIndex"),
                 "episode": m.get("index"), "at": m.get("viewedAt") or 0, "key": m.get("ratingKey"),
                 "show_key": (m.get("grandparentKey") or "").rsplit("/", 1)[-1] or None, "src": "plex"}
                for m in mc.get("Metadata", []) if m.get("type") in ("movie", "episode")]
    return arr.cached(f"plays:plex:{account}:{limit}", 600, load)


def _jf_plays(uid, limit):
    base, h = _jf()

    def load():
        items = _http.get(f"{base}/Users/{uid}/Items", headers=h, params={
            "Recursive": "true", "IncludeItemTypes": "Movie,Episode", "Filters": "IsPlayed", "SortBy": "DatePlayed",
            "SortOrder": "Descending", "Limit": limit, "Fields": "UserData,SeriesId,ParentIndexNumber,IndexNumber,SeriesName"}).json().get("Items", [])
        out = []
        for it in items:
            last = (it.get("UserData") or {}).get("LastPlayedDate")
            at = int(datetime.datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp()) if last else 0
            out.append({"type": "movie" if it["Type"] == "Movie" else "episode", "title": it.get("Name"), "show": it.get("SeriesName"),
                        "season": it.get("ParentIndexNumber"), "episode": it.get("IndexNumber"), "at": at,
                        "key": it["Id"], "show_key": it.get("SeriesId"), "src": "jellyfin"})
        return out
    return arr.cached(f"plays:jf:{uid}:{limit}", 600, load)


# ---------- what a play is (TMDB/TVDB ids, genres, length) ----------
def meta(p):
    """For a movie: the movie. For an episode: its show. {tmdb, tvdb, title, genres, minutes} or None."""
    key = p["key"] if p["type"] == "movie" else p["show_key"]
    if not key:
        return None
    kind = "movie" if p["type"] == "movie" else "tv"
    try:
        return arr.cached(f"meta:{p['src']}:{key}", 86400, lambda: (_plex_meta if p["src"] == "plex" else _jf_meta)(key, kind))
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return None


def _num(v):
    return int(v) if v and str(v).isdigit() else None


def _plex_meta(key, kind):
    base, h = _plex()
    m = _http.get(f"{base}/library/metadata/{key}", headers=h, params={"includeGuids": 1}).json()["MediaContainer"]["Metadata"][0]
    ids = {}
    for g in m.get("Guid", []):
        src, _, val = g.get("id", "").partition("://")
        ids[src] = val
    return {"kind": kind, "tmdb": _num(ids.get("tmdb")), "tvdb": _num(ids.get("tvdb")), "title": m.get("title"), "year": m.get("year"),
            "genres": [g["tag"] for g in m.get("Genre", [])], "minutes": round((m.get("duration") or 0) / 60000) or None}


def _jf_meta(key, kind):
    base, h = _jf()
    it = _http.get(base + "/Items", headers=h, params={"Ids": key, "Fields": "ProviderIds,Genres,RunTimeTicks,ProductionYear"}).json()["Items"][0]
    p = {k.lower(): v for k, v in (it.get("ProviderIds") or {}).items()}
    return {"kind": kind, "tmdb": _num(p.get("tmdb")), "tvdb": _num(p.get("tvdb")), "title": it.get("Name"), "year": it.get("ProductionYear"),
            "genres": it.get("Genres") or [], "minutes": round((it.get("RunTimeTicks") or 0) / 600_000_000) or None}


# ---------- "Because you watched…" ----------
def for_you(user_id, rows=3):
    seen, picks = set(), []
    for p in plays(user_id, 200):
        k = (p["type"], p["key"] if p["type"] == "movie" else p["show_key"])
        if k in seen:
            continue
        seen.add(k)
        m = meta(p)
        if m and m["tmdb"]:
            picks.append(m)
        if len(picks) >= rows:
            break
    out = []
    for m in picks:
        try:
            recs = [r for r in tmdb.extras(m["kind"], m["tmdb"])["recommendations"] if r["status"] != "available"]
        except arr.ArrError:
            continue
        if len(recs) >= 4:
            out.append({"title": f"Because you watched {m['title']}", "items": recs[:20]})
    return out


# ---------- finished a season? ----------
def finished_seasons(user_id, since):
    """[(tvdb, season, show title)] for season finales this person watched after `since`, where the next season exists."""
    out, lib = [], arr.safe(arr.tv_lib, {})
    for p in plays(user_id, 300):
        if p["at"] < since:
            break
        if p["type"] != "episode" or not p["season"]:
            continue
        m = meta(p)
        s = lib.get(m["tvdb"]) if m and m["tvdb"] else None
        if not s:
            continue
        seasons = {x["seasonNumber"]: x for x in s.get("seasons", [])}
        total = ((seasons.get(p["season"]) or {}).get("statistics") or {}).get("totalEpisodeCount")
        if total and p["episode"] == total and p["season"] + 1 in seasons:
            out.append((m["tvdb"], p["season"] + 1, s.get("title") or p["show"]))
    return list(dict.fromkeys(out))


# ---------- Wrapped ----------
def wrapped(user_id, year, tz=0):
    """tz: the viewer's UTC offset in minutes, so 'favorite hour' and 'busiest day' are in their time."""
    shift = tz * 60
    start = calendar.timegm((year, 1, 1, 0, 0, 0)) - shift
    end = calendar.timegm((year + 1, 1, 1, 0, 0, 0)) - shift
    ps = [p for p in plays(user_id, 20000) if start <= p["at"] < end]
    one = {}  # one lookup per movie / show, not per play
    for p in ps:
        one.setdefault((p["src"], p["key"] if p["type"] == "movie" else p["show_key"]), p)
    found = dict(zip(one, _pool.map(meta, one.values())))
    metas = {id(p): found[(p["src"], p["key"] if p["type"] == "movie" else p["show_key"])] for p in ps}
    minutes, movies, episodes = 0, Counter(), 0
    shows, genres, months, hours, days = Counter(), Counter(), Counter(), Counter(), Counter()
    info = {}
    for p in ps:
        m = metas[id(p)] or {}
        dur = m.get("minutes") or (45 if p["type"] == "episode" else 110)
        dt = datetime.datetime.fromtimestamp(p["at"] + shift, datetime.timezone.utc)
        minutes += dur
        months[dt.month] += dur
        hours[dt.hour] += 1
        days[dt.date().isoformat()] += dur
        for g in m.get("genres", [])[:3]:
            genres[g] += dur
        if p["type"] == "movie":
            movies[p["key"]] += 1
            info[("movie", p["key"])] = m | {"fallback": p["title"]}
        else:
            episodes += 1
            shows[p["show_key"]] += 1
            info[("tv", p["show_key"])] = m | {"fallback": p["show"]}

    def card(kind, key, count):
        m = info[(kind, key)]
        ext = m.get("tmdb") if kind == "movie" else m.get("tvdb")
        poster = None
        if ext:
            poster = (arr.safe(lambda: arr.item(kind, ext), None) or {}).get("poster")
        return {"type": kind, "id": ext, "title": m.get("title") or m["fallback"], "count": count, "poster": poster}

    top_shows = [card("tv", k, n) for k, n in shows.most_common(5)]
    top_movies = [card("movie", k, n) for k, n in movies.most_common(5)]
    busiest = days.most_common(1)
    hour = hours.most_common(1)[0][0] if hours else None
    reqs = store.q("select status, done_at from requests where user_id=? and created>=? and created<?", (user_id, start, end))
    likes = store.q1("select count(*) n from swipes where user_id=? and action='like' and created>=? and created<?", (user_id, start, end))["n"]
    return {
        "year": year, "plays": len(ps), "hours": round(minutes / 60), "movies": len(movies), "episodes": episodes,
        "shows": len(shows), "top_shows": top_shows, "top_movies": top_movies,
        "genres": [{"name": g, "hours": round(v / 60, 1)} for g, v in genres.most_common(5)],
        "months": [round(months.get(i, 0) / 60, 1) for i in range(1, 13)],
        "busiest_day": {"date": busiest[0][0], "hours": round(busiest[0][1] / 60, 1)} if busiest else None,
        "favorite_hour": hour,
        "first": (lambda p: {"title": p["show"] or p["title"],
                             "date": datetime.datetime.fromtimestamp(p["at"] + shift, datetime.timezone.utc).date().isoformat()})(ps[-1]) if ps else None,
        "requests": len(reqs), "ready": sum(1 for r in reqs if r["done_at"]), "likes": likes,
    }
