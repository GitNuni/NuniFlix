"""Live channels: the person's own Plex/Jellyfin laid out like old TV. "Fright Night" plays horror back to back, "Sitcom
Comfort" runs two episodes of a show at a time, and so on. Tuning in joins whatever is on, part-way through.

The schedule is worked out, not stored: each channel's titles are shuffled with a seed made from the channel and the
week, then laid end to end from the start of the week. Everyone with the same library sees the same thing on at the same
time, so two people tuned to one channel are watching together. Programmes start on the next 5-minute mark, like TV;
the few minutes in between are the channel's ident.

Watching live doesn't touch resume points or watched status (player.start(live=True) sends no progress to Plex/Jellyfin).
"""
import concurrent.futures, datetime, math, random, threading, time

import httpx

import arr, host, library, player, store

WEEK = 7 * 86400
EPOCH = 1704704400  # Monday 8 Jan 2024 09:00 UTC: weeks turn over early morning in the Americas, mid-morning in Europe
PAD = 300           # programmes start on 5-minute marks
MIN_ITEMS = 5

# key, name, tagline, kind, genres (any of; Plex and Jellyfin name some differently), decade
CHANNELS = [
    ("fright", "Fright Night", "Horror, all day and all night", "movie", ["Horror"], None),
    ("sitcom", "Sitcom Comfort", "Back-to-back episodes, no thinking required", "tv", ["Comedy"], None),
    ("action", "Blockbuster", "Explosions on the hour", "movie", ["Action", "Adventure"], None),
    ("laughs", "Laugh Track", "Comedies, start to finish", "movie", ["Comedy"], None),
    ("scifi", "Deep Space", "Science fiction and the unknown", "movie", ["Science Fiction", "Sci-Fi"], None),
    ("after", "After Dark", "Thrillers, crime and mysteries", "movie", ["Thriller", "Crime", "Mystery"], None),
    ("toons", "Saturday Morning", "Cartoons, any day of the week", "tv", ["Animation"], None),
    ("family", "Family Room", "Something for everyone on the couch", "movie", ["Family", "Animation"], None),
    ("feels", "The Big Feels", "Dramas and love stories", "movie", ["Drama", "Romance"], None),
    ("80s", "Rewind '80s", "Big hair, synths and practical effects", "movie", [], 1980),
    ("90s", "Rewind '90s", "Be kind, rewind", "movie", [], 1990),
    ("real", "Real Stuff", "Documentaries and true stories", "tv", ["Documentary", "Reality"], None),
]


class NoChannels(player.PlayError):
    pass


# ---------- what each channel can play ----------
def _plex_movies(token, genres, decade):
    out = {}
    for key, kind in library._plex_sections(token):
        if kind != "movie":
            continue
        ids = library._plex_genre_ids(token, key)
        filters = [{"decade": decade}] if decade else [{"genre": ids[g]} for g in genres if g in ids]
        for f in filters:
            d = library._px(token, f"/library/sections/{key}/all", type=1, includeGuids=1, **f)
            for m in d.get("Metadata", []):
                g = library._guids(m)
                out[str(m["ratingKey"])] = {
                    "id": str(m["ratingKey"]), "kind": "movie", "ext": g.get("tmdb"), "tmdb": g.get("tmdb"), "title": m.get("title"),
                    "sub": str(m["year"]) if m.get("year") else None, "show": None, "dur": (m.get("duration") or 0) / 1000,
                    "poster": library.art_url("plex", m.get("thumb"), "poster"), "backdrop": library.art_url("plex", m.get("art"), "backdrop"),
                    "overview": m.get("summary")}
    return list(out.values())


def _plex_shows(token, genres):
    out = {}
    for key, kind in library._plex_sections(token):
        if kind != "tv":
            continue
        ids = library._plex_genre_ids(token, key)
        for g in genres:
            if g in ids:
                d = library._px(token, f"/library/sections/{key}/all", type=2, includeGuids=1, genre=ids[g])
                for m in d.get("Metadata", []):
                    out[str(m["ratingKey"])] = m
    return [(k, out[k]) for k in sorted(out)]


def _plex_episodes(token, key, show):
    def load():
        eps = library._px(token, f"/library/metadata/{key}/allLeaves").get("Metadata", [])
        g = library._guids(show)
        return [{"id": str(e["ratingKey"]), "kind": "tv", "ext": g.get("tvdb"), "tmdb": g.get("tmdb"), "title": e.get("title"),
                 "sub": f"S{e.get('parentIndex')} · E{e.get('index')}", "show": show.get("title"), "dur": (e.get("duration") or 0) / 1000,
                 "poster": library.art_url("plex", show.get("thumb"), "poster"), "backdrop": library.art_url("plex", show.get("art"), "backdrop"),
                 "overview": e.get("summary")} for e in eps if e.get("Media")]
    return arr.cached(f"live:px:eps:{token[-8:]}:{key}", 6 * 3600, load)


def _jf_movies(token, uid, genres, decade):
    q = {"userId": uid, "Recursive": "true", "IncludeItemTypes": "Movie", "Fields": "ProviderIds,Overview", "Limit": 2000}
    q.update({"Years": ",".join(str(y) for y in range(decade, decade + 10))} if decade else {"Genres": "|".join(genres)})
    out = []
    for it in library._jfget(token, "/Items", **q).get("Items", []):
        ids = {k.lower(): int(v) for k, v in (it.get("ProviderIds") or {}).items() if k.lower() in ("tmdb", "tvdb") and str(v).isdigit()}
        out.append({"id": it["Id"], "kind": "movie", "ext": ids.get("tmdb"), "tmdb": ids.get("tmdb"), "title": it.get("Name"),
                    "sub": str(it["ProductionYear"]) if it.get("ProductionYear") else None, "show": None, "dur": (it.get("RunTimeTicks") or 0) / 1e7,
                    "poster": library.art_url("jellyfin", f"/Items/{it['Id']}/Images/Primary", "poster"),
                    "backdrop": library.art_url("jellyfin", f"/Items/{it['Id']}/Images/Backdrop", "backdrop"), "overview": it.get("Overview")})
    return out


def _jf_shows(token, uid, genres):
    d = library._jfget(token, "/Items", userId=uid, Recursive="true", IncludeItemTypes="Series", Genres="|".join(genres),
                       Fields="ProviderIds", Limit=1000)
    return sorted(((it["Id"], it) for it in d.get("Items", [])), key=lambda x: x[0])


def _jf_episodes(token, uid, sid, show):
    def load():
        ids = {k.lower(): int(v) for k, v in (show.get("ProviderIds") or {}).items() if k.lower() in ("tmdb", "tvdb") and str(v).isdigit()}
        eps = library._jfget(token, f"/Shows/{sid}/Episodes", userId=uid, Fields="Overview").get("Items", [])
        return [{"id": e["Id"], "kind": "tv", "ext": ids.get("tvdb"), "tmdb": ids.get("tmdb"), "title": e.get("Name"),
                 "sub": f"S{e.get('ParentIndexNumber')} · E{e.get('IndexNumber')}", "show": show.get("Name"), "dur": (e.get("RunTimeTicks") or 0) / 1e7,
                 "poster": library.art_url("jellyfin", f"/Items/{sid}/Images/Primary", "poster"),
                 "backdrop": library.art_url("jellyfin", f"/Items/{sid}/Images/Backdrop", "backdrop"), "overview": e.get("Overview")}
                for e in eps if e.get("LocationType") != "Virtual"]
    return arr.cached(f"live:jf:eps:{sid}", 6 * 3600, load)


def _ok(x):
    return 300 <= x["dur"] <= 4 * 3600


def _pool(user, ch, week):
    """Movies: every title that fits. Shows: {show: [episodes in order]} for up to 12 of the genre's shows, picked per week."""
    key, _, _, kind, genres, decade = ch
    src, token, ident = player._access(user)
    uid = ident[3:] if src == "jellyfin" else None

    def load():
        if kind == "movie":
            items = _plex_movies(token, genres, decade) if src == "plex" else _jf_movies(token, uid, genres, decade)
            return sorted((x for x in items if _ok(x)), key=lambda x: x["id"])
        shows = _plex_shows(token, genres) if src == "plex" else _jf_shows(token, uid, genres)
        rng = random.Random(f"{key}:shows:{week}")
        picked = rng.sample(shows, min(12, len(shows)))
        out = {}
        for sid, show in picked:
            eps = _plex_episodes(token, sid, show) if src == "plex" else _jf_episodes(token, uid, sid, show)
            eps = [e for e in eps if _ok(e)]
            if eps:
                out[sid] = eps
        return out
    return arr.cached(f"live:pool:{src}:{token[-8:]}:{key}:{week if kind == 'tv' else ''}", 6 * 3600, load)


# ---------- the schedule ----------
def _ceil(t):
    return math.ceil(t / PAD) * PAD


def _lay(ch, pool, week, start, seed=None, stop=None):
    """Programmes for one week from `start`: [(item, start, end, slot_end)]."""
    key, kind = ch[0], ch[3]
    rng = random.Random(seed or f"{key}:{week}")
    stop = stop or EPOCH + (week + 1) * WEEK
    out, t = [], start
    if kind == "movie":
        order, last = [], None
        while t < stop:
            if not order:
                order = pool[:]
                rng.shuffle(order)
                if len(order) > 1 and order[-1]["id"] == last:
                    order[0], order[-1] = order[-1], order[0]
            x = order.pop()
            last = x["id"]
            end = t + x["dur"]
            slot = _ceil(end)
            out.append((x, t, end, slot))
            t = slot
    else:
        shows, last = sorted(pool), None
        while t < stop:
            choices = [s for s in shows if s != last] or shows
            last = rng.choice(choices)
            eps = pool[last]
            i = rng.randrange(len(eps))
            block = eps[i:i + 2]
            for n, x in enumerate(block):
                end = t + x["dur"]
                slot = _ceil(end) if n == len(block) - 1 else end
                out.append((x, t, end, slot))
                t = slot
    return out


_sched, _sched_lock = {}, threading.Lock()


def _week(user, ch, week):
    src, token, _ = player._access(user)
    ck = (src, token[-8:], ch[0], week)
    with _sched_lock:
        hit = _sched.get(ck)
        if hit and hit[0] > time.time():
            return hit[1]
    pool = _pool(user, ch, week)
    if len(pool) < (MIN_ITEMS if ch[3] == "movie" else 2):
        progs = []
    else:
        start = EPOCH + week * WEEK
        prev_pool = _pool(user, ch, week - 1) if ch[3] == "tv" else pool
        if len(prev_pool) >= (MIN_ITEMS if ch[3] == "movie" else 2):  # carry on from where last week's last programme ends
            prev = _lay(ch, prev_pool, week - 1, EPOCH + (week - 1) * WEEK)
            start = max(start, prev[-1][3]) if prev else start
        progs = _lay(ch, pool, week, start)
    with _sched_lock:
        _sched[ck] = (time.time() + 3600, progs)
        if len(_sched) > 400:
            _sched.pop(next(iter(_sched)))
    return progs


# ---------- takeovers: special days on Fright Night ----------
# key: (name, tagline, TMDB keywords). Fright Night plays only the matching horror from the library that day (all of
# its horror if fewer than 4 match), under the takeover's name, from local midnight to midnight.
TAKEOVERS = {
    "halloween": ("Halloween Night", "All day. All night. No tricks. Well, some tricks.", ["halloween"]),
    "krampus": ("Krampusnacht", "Be good. He's checking.", ["krampus", "christmas"]),
    "xmaseve": ("Slay Bells", "Christmas Eve, and something is stirring", ["christmas"]),
    "valentine": ("Love Bites", "Valentine's Day, horror style", ["valentine's day", "obsession", "stalker"]),
    "friday13": ("Friday the 13th", "Stay out of the woods", ["slasher", "summer camp"]),
    "fullmoon": ("Full Moon", "Werewolves on the hour", ["werewolf"]),
}
SYNODIC, NEW_MOON = 29.530588853, 947182440  # a new moon: 6 Jan 2000 18:14 UTC


def full_moon(d):
    """Is the moon (near) full on this date? Within ~a day of it, at local midday."""
    t = datetime.datetime(d.year, d.month, d.day, 12, tzinfo=datetime.timezone.utc).timestamp()
    age = ((t - NEW_MOON) / 86400) % SYNODIC
    return abs(age - SYNODIC / 2) < 1.0


def takeover_for(d):
    if (d.month, d.day) == (10, 31):
        return "halloween"
    if (d.month, d.day) == (12, 5):
        return "krampus"
    if (d.month, d.day) == (12, 24):
        return "xmaseve"
    if d.day == 13 and d.weekday() == 4:
        return "friday13"
    if (d.month, d.day) == (2, 14):
        return "valentine"
    if full_moon(d):
        return "fullmoon"
    return None


def _local_date(now, tz):
    return datetime.datetime.fromtimestamp(now + tz * 60, datetime.timezone.utc).date()


def _keyword_hits(words):
    """TMDB ids of horror films with any of these keywords (a few pages, kept a day)."""
    import seasonal, tmdb
    if not tmdb.key():
        return set()
    ids = [str(k) for k in (seasonal._keyword(w) for w in words) if k]
    if not ids:
        return set()

    def load():
        out = set()
        for page in range(1, 6):
            d = tmdb.get("/discover/movie", with_genres="27", with_keywords="|".join(ids), sort_by="popularity.desc",
                         include_adult="false", page=page)
            out |= {r["id"] for r in d.get("results", [])}
            if page >= d.get("total_pages", 1):
                break
        return sorted(out)
    return set(arr.cached("live:kw:" + "|".join(ids), 86400, load))


def _takeover_programs(user, ch, tk, now, tz, t0, t1):
    src, token, _ = player._access(user)
    d = _local_date(now, tz)
    ck = (src, token[-8:], "takeover", tk, d.isoformat(), tz)
    with _sched_lock:
        hit = _sched.get(ck)
    if hit and hit[0] > time.time():
        progs = hit[1]
    else:
        pool = _pool(user, ch, int((now - EPOCH) // WEEK))
        try:
            hits = _keyword_hits(TAKEOVERS[tk][2])
        except Exception:  # TMDB down: the whole horror pool, renamed
            hits = set()
        matched = [x for x in pool if x.get("tmdb") in hits]
        use = matched if len(matched) >= 4 else pool
        midnight = datetime.datetime(d.year, d.month, d.day, tzinfo=datetime.timezone.utc).timestamp() - tz * 60
        progs = _lay(ch, use, 0, midnight, seed=f"{ch[0]}:{tk}:{d}", stop=midnight + 36 * 3600) if len(use) >= 2 else []
        with _sched_lock:
            _sched[ck] = (time.time() + 3600, progs)
    return [p for p in progs if p[3] > t0 and p[1] < t1]


def _programs(user, ch, t0, t1, tz=None, now=None):
    """Programmes overlapping [t0, t1). On a takeover day (local date from tz), Fright Night plays the takeover."""
    if tz is not None and ch[0] == "fright":
        now = now or time.time()
        tk = takeover_for(_local_date(now, tz))
        if tk:
            progs = _takeover_programs(user, ch, tk, now, tz, t0, t1)
            if progs:
                return progs
    week = int((t0 - EPOCH) // WEEK)
    progs = _week(user, ch, week)
    if progs and progs[-1][3] < t1:
        progs = progs + _week(user, ch, week + 1)
    return [p for p in progs if p[3] > t0 and p[1] < t1]


def _shape(p):
    x, start, end, slot = p
    return {k: x[k] for k in ("id", "kind", "ext", "tmdb", "title", "sub", "show", "poster", "backdrop", "overview")} | {
        "start": start, "end": end, "slot_end": slot}


def lineup(user, hours=4, tz=None):
    """{now, source, channels: [{key, number, name, tagline, kind, programs}]}: what's on from the top of this half hour
    to a few hours ahead (so the first programme may have finished already)."""
    src = player._access(user)[0]
    now = time.time()
    tk = takeover_for(_local_date(now, tz)) if tz is not None else None

    def one(ch):
        try:
            return ch, _programs(user, ch, now // 1800 * 1800, now + hours * 3600, tz, now)  # from the top of the half hour, for the guide
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            return ch, None
    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        results = list(ex.map(one, CHANNELS))
    if all(r is None for _, r in results):
        raise NoChannels(f"Couldn't reach {store.SOURCES[src]} right now.")
    out, n = [], 2
    for ch, progs in results:
        if progs:
            name, tagline, takeover = ch[1], ch[2], None
            if tk and ch[0] == "fright":
                name, tagline, takeover = TAKEOVERS[tk][0], TAKEOVERS[tk][1], tk
            out.append({"key": ch[0], "number": n, "name": name, "tagline": tagline, "kind": ch[3], "takeover": takeover,
                        "programs": [_shape(p) for p in progs]})
            n += 1
    if not out:
        raise NoChannels(f"Not enough on your {store.SOURCES[src]} to make channels yet.")
    hour = _local_hour(now, tz)
    return {"now": now, "source": src, "channels": out, "takeover": tk, "host": host.greeting(hour, tk)}


def _local_hour(now, tz):
    return datetime.datetime.fromtimestamp(now + tz * 60, datetime.timezone.utc).hour if tz is not None else None


def tune(user, key, tz=None):
    """What's on a channel right now: {program, offset, next}. offset is seconds into it; negative means it starts in
    that many seconds (the ident between programmes)."""
    ch = next((c for c in CHANNELS if c[0] == key), None)
    if not ch:
        raise player.PlayError("No such channel.")
    now = time.time()
    try:
        progs = _programs(user, ch, now, now + 6 * 3600, tz, now)
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        raise player.PlayError(f"Couldn't reach {store.SOURCES[player._access(user)[0]]} right now.")
    if not progs:
        raise player.PlayError("Nothing on that channel right now.")
    cur = progs[0]
    if cur[2] <= now and len(progs) > 1:  # between programmes: the next one is about to start
        cur = progs[1]
    nxt = progs[progs.index(cur) + 1] if progs.index(cur) + 1 < len(progs) else None
    tk = takeover_for(_local_date(now, tz)) if tz is not None and key == "fright" else None
    name = TAKEOVERS[tk][0] if tk else ch[1]
    offset = now - cur[1]
    return {"now": now, "program": _shape(cur), "offset": offset, "next": _shape(nxt) if nxt else None,
            "channel": {"key": key, "name": name, "tagline": TAKEOVERS[tk][1] if tk else ch[2], "takeover": tk},
            "host": host.line(_shape(cur), name, _local_hour(now, tz), offset, tk)}
