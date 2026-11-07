"""The Office: a live building where every floor is something actually happening on the owner's servers.

Screening rooms = who's watching what on Plex / Jellyfin right now. Loading dock = Radarr/Sonarr downloads.
Search desk = approved requests still being looked for (and searches running this second). Mailroom = requests
waiting for approval and things delivered in the last two days. A log of what changed, built by comparing snapshots.

One snapshot is shared by everyone looking; names and titles are redacted per viewer. Requests never wait on the
servers: refresh() (the background thread) rebuilds it every LIVE seconds while someone has the page open, every
IDLE seconds otherwise (to keep the log going), and a request just reads the latest one.
"""
import collections, hashlib, secrets, threading, time

import httpx

import arr, history, store

_http = httpx.Client(timeout=8, headers={"Accept": "application/json"})
_lock = threading.Lock()
_snap = {"at": 0, "data": None, "seen": 0}  # seen = when someone last asked for it
LIVE, IDLE = 8, 30
_events = collections.deque(maxlen=60)  # {at, kind, uid, who, title, src}
_prev = {"streams": None, "downloads": None}
_art = collections.OrderedDict()  # opaque id -> (source, path), so the browser never sees server addresses or tokens
_art_bytes = {}
_SEARCHES = {"MoviesSearch", "MissingMoviesSearch", "CutoffUnmetMoviesSearch", "EpisodeSearch", "SeasonSearch",
             "SeriesSearch", "MissingEpisodeSearch", "CutoffUnmetEpisodeSearch"}


def hue(key):
    return int(hashlib.sha1(str(key).encode()).hexdigest()[:4], 16) % 360


def _art_id(src, path):
    if not path:
        return None
    for k, v in _art.items():
        if v == (src, path):
            return k
    k = secrets.token_urlsafe(9)
    _art[k] = (src, path)
    while len(_art) > 400:
        old, _ = _art.popitem(last=False)
        _art_bytes.pop(old, None)
    return k


def art(aid):
    """Image bytes for an art id (fetched with the server's own credentials, kept a while)."""
    if aid not in _art:
        return None
    hit = _art_bytes.get(aid)
    if hit and hit[0] > time.time():
        return hit[1], hit[2]
    src, path = _art[aid]
    conn = history._plex() if src == "plex" else history._jf()
    if not conn:
        return None
    base, h = conn
    if src == "plex":
        r = _http.get(base + "/photo/:/transcode", headers=h, params={"url": path, "width": 640, "height": 360, "minSize": 1})
    else:
        r = _http.get(base + path, headers=h, params={"maxWidth": 640, "quality": 80})
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
        return None
    _art_bytes[aid] = (time.time() + 900, r.content, r.headers["content-type"])
    return r.content, r.headers["content-type"]


# ---------- who's who ----------
def _people():
    """identity key from a server session -> (user id, name)."""
    out = {}
    for r in store.q("select i.id, i.owner, i.source, u.id uid, u.name from identities i join users u on u.id=i.user_id "
                     "where i.source in ('plex','jellyfin')"):
        if r["source"] == "plex":
            out["plex:" + r["id"].split(":", 1)[1]] = (r["uid"], r["name"])
            if r["owner"]:
                out["plex:1"] = (r["uid"], r["name"])  # Plex calls the server owner account 1 in sessions
        else:
            out["jf:" + r["id"][3:].replace("-", "").lower()] = (r["uid"], r["name"])
    return out


# ---------- floors ----------
def _streams():
    people, out = _people(), []
    p = history._plex()
    if p:
        try:
            mc = _http.get(p[0] + "/status/sessions", headers=p[1]).json()["MediaContainer"]
            for m in mc.get("Metadata", []):
                if m.get("type") not in ("movie", "episode"):
                    continue
                u, pl = m.get("User") or {}, m.get("Player") or {}
                uid, name = people.get(f"plex:{u.get('id')}", (None, u.get("title") or "Someone"))
                ep = m["type"] == "episode"
                dur = m.get("duration") or 0
                out.append({"key": "plex:" + str(m.get("sessionKey") or m.get("ratingKey")), "src": "plex", "uid": uid, "who": name,
                            "kind": "episode" if ep else "movie",
                            "title": m.get("grandparentTitle") if ep else m.get("title"),
                            "sub": f"S{m.get('parentIndex')} E{m.get('index')} · {m.get('title')}" if ep else str(m.get("year") or ""),
                            "art": _art_id("plex", m.get("thumb") if ep else (m.get("art") or m.get("thumb"))),
                            "pct": round(100 * (m.get("viewOffset") or 0) / dur) if dur else None,
                            "state": pl.get("state") or "playing", "device": pl.get("product") or pl.get("platform"),
                            "transcode": (m.get("TranscodeSession") or {}).get("videoDecision") == "transcode"})
        except (httpx.HTTPError, ValueError, KeyError):
            pass
    j = history._jf()
    if j:
        try:
            for s in _http.get(j[0] + "/Sessions", headers=j[1], params={"activeWithinSeconds": 600}).json():
                n = s.get("NowPlayingItem")
                if not n or n.get("Type") not in ("Movie", "Episode"):
                    continue
                ps = s.get("PlayState") or {}
                uid, name = people.get("jf:" + (s.get("UserId") or "").replace("-", "").lower(), (None, s.get("UserName") or "Someone"))
                ep = n["Type"] == "Episode"
                run = n.get("RunTimeTicks") or 0
                img = (f"/Items/{n['Id']}/Images/Primary" if ep else
                       f"/Items/{n['Id']}/Images/Backdrop/0" if n.get("BackdropImageTags") else
                       f"/Items/{n.get('ParentBackdropItemId') or n['Id']}/Images/Backdrop/0")
                out.append({"key": "jf:" + s["Id"], "src": "jellyfin", "uid": uid, "who": name, "kind": "episode" if ep else "movie",
                            "title": n.get("SeriesName") if ep else n.get("Name"),
                            "sub": f"S{n.get('ParentIndexNumber')} E{n.get('IndexNumber')} · {n.get('Name')}" if ep else str(n.get("ProductionYear") or ""),
                            "art": _art_id("jellyfin", img),
                            "pct": round(100 * (ps.get("PositionTicks") or 0) / run) if run else None,
                            "state": "paused" if ps.get("IsPaused") else "playing", "device": s.get("Client"),
                            "transcode": ps.get("PlayMethod") == "Transcode"})
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass
    return out


def _downloads():
    out = []
    for srv in ("radarr", "sonarr", "radarr4k", "sonarr4k"):
        if not arr.has(srv):
            continue
        movie = srv.startswith("radarr")
        try:
            recs = arr.call(srv, "GET", "/api/v3/queue", params={"pageSize": 100, "includeMovie": "true", "includeSeries": "true",
                                                                  "includeEpisode": "true"})["records"]
        except arr.ArrError:
            continue
        for r in recs:
            m = (r.get("movie") if movie else r.get("series")) or {}
            e = r.get("episode") or {}
            size, left = r.get("size") or 0, r.get("sizeleft") or 0
            st = (r.get("trackedDownloadState") or "").lower()
            state = ("stuck" if r.get("trackedDownloadStatus") in ("warning", "error") or r.get("status") in ("warning", "failed")
                     else "importing" if st in ("importpending", "importing") or (size and not left)
                     else "paused" if r.get("status") == "paused"
                     else "queued" if r.get("status") in ("queued", "delay") else "downloading")
            out.append({"key": f"{srv}:{r.get('id')}", "srv": srv, "kind": "movie" if movie else "tv",
                        "title": m.get("title") or r.get("title"),
                        "sub": (f"S{e.get('seasonNumber')} E{e.get('episodeNumber')}" if e else "") + (" · 4K" if srv.endswith("4k") else ""),
                        "poster": arr._img(m.get("images"), "poster"),
                        "pct": round(100 * (size - left) / size) if size else 0, "left": arr._secs(r.get("timeleft")),
                        "size": size, "state": state, "client": r.get("downloadClient")})
    # one box per show: several episodes of the same show download together
    merged = {}
    for d in out:
        k = (d["srv"], d["title"]) if d["kind"] == "tv" else d["key"]
        if k in merged:
            m = merged[k]
            m["n"] = m.get("n", 1) + 1
            m["size"], done = m["size"] + d["size"], m["pct"] * m["size"] / 100 + d["pct"] * d["size"] / 100
            m["pct"] = round(100 * done / m["size"]) if m["size"] else 0
            m["left"] = max(m["left"] or 0, d["left"] or 0) or None
            m["sub"] = f"{m['n']} episodes" + (" · 4K" if d["srv"].endswith("4k") else "")
            if d["state"] == "stuck" or m["state"] != "downloading":
                m["state"] = d["state"] if d["state"] in ("stuck", "downloading") else m["state"]
        else:
            merged[k] = dict(d)
    return list(merged.values())


def _searching(downloading):
    """Approved requests that aren't here yet and aren't downloading: someone at the search desk is on it."""
    active, feeds = {"movie": set(), "tv": set()}, {}
    libs = {"movie": arr.safe(arr.movie_lib, {}), "tv": arr.safe(arr.tv_lib, {})}
    by_id = {k: {v["id"]: ext for ext, v in lib.items()} for k, lib in libs.items()}
    for srv, kind in (("radarr", "movie"), ("sonarr", "tv")):
        if not arr.has(srv):
            continue
        try:
            cmds = arr.cached(f"office:cmd:{srv}", 4, lambda srv=srv: arr.call(srv, "GET", "/api/v3/command"))
        except arr.ArrError:
            continue
        for c in cmds:
            if c.get("name") == "RssSync" and c.get("status") == "completed":
                feeds[kind] = max(feeds.get(kind, ""), c.get("ended") or "")
            if c.get("name") in _SEARCHES and c.get("status") in ("queued", "started"):
                b = c.get("body") or {}
                ids = b.get("movieIds") or ([b["seriesId"]] if b.get("seriesId") else [])
                if c["name"].startswith(("Missing", "Cutoff")):
                    active[kind].add("all")
                for i in ids:
                    if i in by_id[kind]:
                        active[kind].add(by_id[kind][i])
    out, seen = [], set()
    for r in store.q("select r.type, r.ext_id, r.title, r.poster, r.created, u.name, r.user_id from requests r "
                     "left join users u on u.id=r.user_id where r.status='approved' and r.is4k=0 order by r.created desc limit 80"):
        k = (r["type"], r["ext_id"])
        if k in seen or (r["type"], r["title"]) in downloading:
            continue
        seen.add(k)
        st, _ = arr.state(r["type"], r["ext_id"])
        if st == "available":
            continue
        lib = libs[r["type"]].get(r["ext_id"]) or {}
        why = arr.safe(lambda: arr.why(r["type"], r["ext_id"]), None) if lib else None
        now = r["ext_id"] in active[r["type"]] or "all" in active[r["type"]]
        out.append({"key": f"{r['type']}:{r['ext_id']}", "kind": r["type"], "title": r["title"], "poster": r["poster"],
                    "uid": r["user_id"], "who": r["name"], "since": r["created"], "now": now,
                    "why": "Searching right now" if now else (why or "Waiting for a release"),
                    "asleep": not now and bool(why) and why.startswith(("In theaters", "Caught up", "Looking for episodes · next")),
                    "partial": st == "partial"})
        if len(out) >= 12:
            break
    return out, feeds


def _mailroom():
    pending = [dict(r) for r in store.q(
        "select r.id, r.type, r.title, r.poster, r.created, r.user_id uid, u.name who from requests r left join users u on u.id=r.user_id "
        "where r.status='pending' order by r.created desc limit 12")]
    cutoff = time.time() - 2 * 86400
    delivered = [dict(r) for r in store.q(
        "select r.id, r.type, r.title, r.poster, r.done_at at, r.user_id uid, u.name who from requests r left join users u on u.id=r.user_id "
        "where r.done_at > ? order by r.done_at desc limit 12", (cutoff,))]
    return pending, delivered


def _diff(streams, downloads):
    now = time.time()
    ps, pd = _prev["streams"], _prev["downloads"]
    if ps is not None:
        cur = {s["key"]: s for s in streams}
        for k, s in cur.items():
            if k not in ps:
                _events.append({"at": now, "kind": "watch", "uid": s["uid"], "who": s["who"], "title": s["title"], "src": s["src"]})
        for k, s in ps.items():
            if k not in cur:
                _events.append({"at": now, "kind": "stop", "uid": s["uid"], "who": s["who"], "title": s["title"], "src": s["src"]})
    if pd is not None:
        cur = {d["key"]: d for d in downloads}
        for k, d in cur.items():
            if k not in pd:
                _events.append({"at": now, "kind": "dl", "title": d["title"], "sub": d["sub"]})
        for k, d in pd.items():
            if k not in cur:
                _events.append({"at": now, "kind": "dl_done" if d["pct"] >= 95 or d["state"] == "importing" else "dl_gone",
                                "title": d["title"], "sub": d["sub"]})
    _prev["streams"] = {s["key"]: s for s in streams}
    _prev["downloads"] = {d["key"]: d for d in downloads}


def snapshot():
    """The latest snapshot (only built here if there isn't one yet)."""
    _snap["seen"] = time.time()
    return _snap["data"] or _build()


def refresh():
    """Called every couple of seconds by the background thread: rebuild if it's due."""
    age, watched = time.time() - _snap["at"], time.time() - _snap["seen"] < 3 * LIVE
    if not _snap["data"] or age >= (LIVE if watched else IDLE):
        _build()


def _build():
    with _lock:
        if _snap["data"] and time.time() - _snap["at"] < 2:  # someone else just did it
            return _snap["data"]
        streams, downloads = _streams(), _downloads()
        searching, feeds = _searching({(d["kind"], d["title"]) for d in downloads})
        pending, delivered = _mailroom()
        _diff(streams, downloads)
        _snap.update(at=time.time(), data={"streams": streams, "downloads": downloads, "searching": searching, "feeds": feeds,
                                           "pending": pending, "delivered": delivered})
        return _snap["data"]


def log(limit=30):
    """Newest first: what changed in the building (snapshots) plus requests from the database."""
    ev = list(_events)
    since = time.time() - 2 * 86400
    for r in store.q("select r.title, r.created, r.status, r.user_id uid, u.name who from requests r left join users u on u.id=r.user_id "
                     "where r.created > ? order by r.created desc limit 20", (since,)):
        ev.append({"at": r["created"], "kind": "req", "uid": r["uid"], "who": r["who"], "title": r["title"]})
    for r in store.q("select r.title, r.done_at, r.user_id uid, u.name who from requests r left join users u on u.id=r.user_id "
                     "where r.done_at > ? order by r.done_at desc limit 20", (since,)):
        ev.append({"at": r["done_at"], "kind": "delivered", "uid": r["uid"], "who": r["who"], "title": r["title"]})
    return sorted(ev, key=lambda e: -e["at"])[:limit]


def view(user):
    """The snapshot as this person may see it. Admins (and everyone, if the owner allows) see names and titles;
    otherwise other people's viewing is just 'someone watching something' (people only see their own watching)."""
    c, admin = store.config(), store.is_admin(user)
    open_ = admin or c.get("office_names")
    reqnames = admin or c.get("show_requester")
    d = snapshot()

    def person(uid, who, names=open_):
        if uid and uid == user["id"]:
            return {"who": "You", "me": True, "hue": hue(uid)}
        return {"who": (who or "Someone").split()[0][:16] if names else "Someone", "me": False, "hue": hue(uid or who) if names else 220}

    streams = []
    for s in d["streams"]:
        mine = s["uid"] == user["id"]
        show = open_ or mine
        streams.append({"key": hashlib.sha1(s["key"].encode()).hexdigest()[:10], **person(s["uid"], s["who"]),
                        "src": s["src"], "kind": s["kind"], "state": s["state"], "pct": s["pct"], "transcode": s["transcode"] and show,
                        "title": s["title"] if show else None, "sub": s["sub"] if show else None,
                        "art": f"/api/office/art/{s['art']}" if show and s["art"] else None,
                        "device": s["device"] if show else None})
    events = []
    for e in log():
        if e["kind"] in ("watch", "stop") and not (open_ or e.get("uid") == user["id"]):
            e = {**e, "title": None}
        p = person(e.get("uid"), e.get("who"), reqnames if e["kind"] in ("req", "delivered") else open_) if "who" in e else {}
        events.append({k: v for k, v in e.items() if k not in ("uid", "who")} | ({"who": p["who"], "hue": p["hue"]} if p else {}))
    strip = lambda rows: [{k: v for k, v in r.items() if k not in ("uid", "who", "id")} | person(r.get("uid"), r.get("who"), reqnames)
                          for r in rows]
    return {"streams": streams, "downloads": d["downloads"], "searching": strip(d["searching"]), "feeds": d["feeds"],
            "pending": strip(d["pending"]), "delivered": strip(d["delivered"]), "events": events,
            "brand": store.app_name(c), "now": time.time()}


def demo(user):
    """A busy afternoon, made up from this week's trending titles, so the owner can see every room in use."""
    import tmdb
    now, me = time.time(), {"who": "You", "me": True, "hue": hue(user["id"])}
    pool = [x for x in arr.safe(tmdb.trending_quick, []) if x.get("poster") and x.get("backdrop")]
    pick = lambda i: pool[i % len(pool)] if pool else {"title": "Something good", "poster": None, "backdrop": None, "type": "movie", "year": None}
    t = lambda i: {"title": pick(i)["title"], "poster": pick(i)["poster"], "kind": pick(i)["type"]}
    max_, lena = {"who": "Max", "me": False, "hue": 140}, {"who": "Lena", "me": False, "hue": 290}
    st = lambda i, who, state, pct, tc, dev: {"key": f"d{i}", **who, "src": "plex" if i % 2 else "jellyfin", "kind": "movie", "state": state,
                                              "pct": pct, "transcode": tc, "title": pick(i)["title"], "sub": str(pick(i).get("year") or ""),
                                              "device": dev, "art": pick(i)["backdrop"]}
    return {
        "demo": True, "brand": store.app_name(), "now": now,
        "streams": [st(0, me, "playing", 42, False, "Apple TV"), st(1, max_, "playing", 77, True, "Infuse"), st(2, lena, "paused", 12, False, "iPhone")],
        "downloads": [{"key": "x1", "state": "downloading", "pct": 63, "left": 540, "sub": "", **t(3)},
                      {"key": "x2", "state": "downloading", "pct": 18, "left": 2400, "sub": "4 episodes", **t(4)},
                      {"key": "x3", "state": "importing", "pct": 100, "left": 0, "sub": "", **t(5)},
                      {"key": "x4", "state": "stuck", "pct": 3, "left": None, "sub": "", **t(6)}],
        "searching": [{"key": "s1", "now": True, "why": "Searching right now", "asleep": False, **max_, **t(7)},
                      {"key": "s2", "now": False, "why": "In theaters · digital release Dec 9", "asleep": True, **me, **t(8)},
                      {"key": "s3", "now": False, "why": "Released · looking for a good copy", "asleep": False, **lena, **t(9)}],
        "feeds": {"movie": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 240))},
        "pending": [{"created": now - 600, **lena, **t(10)}, {"created": now - 3600, **max_, **t(11)}],
        "delivered": [{"at": now - 1800, **me, **t(12)}, {"at": now - 7200, **max_, **t(13)}, {"at": now - 20000, **lena, **t(14)}],
        "events": [{"at": now - 20, "kind": "watch", **max_, "title": pick(1)["title"], "src": "jellyfin"},
                   {"at": now - 95, "kind": "dl_done", "title": pick(5)["title"], "sub": ""},
                   {"at": now - 600, "kind": "req", **lena, "title": pick(10)["title"]},
                   {"at": now - 1800, "kind": "delivered", **me, "title": pick(12)["title"]},
                   {"at": now - 2400, "kind": "dl", "title": pick(4)["title"], "sub": "4 episodes"}],
    }
