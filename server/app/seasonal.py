"""Seasonal horror channels: one themed channel at a time, picked by date (same seasons as web/season.js).

Each row is a TMDB keyword search inside the Horror genre (keywords are looked up by name once and remembered),
plus "On your server" from the person's own library when it has horror. Late at night ("Horror Hours", the
client sends its local hour) a row of short horror joins in.
"""
import datetime, os

import arr, tmdb

CHANNELS = {
    "halloween": ("31 Nights of Horror", "A scare for every night of October",
                  [("Halloween night", ["halloween"]), ("Slashers", ["slasher"]), ("Haunted houses", ["haunted house"]),
                   ("Witches & the occult", ["witch", "occult"])]),
    "fall": ("Harvest of Horror", "Folk horror, small towns and something nasty at the dinner table",
             [("Folk horror", ["folk horror"]), ("Small-town terror", ["small town"]), ("Thanksgiving & harvest horror", ["thanksgiving", "harvest"]),
              ("Cannibals", ["cannibal"])]),
    "christmas": ("Holiday Horror", "Krampus is coming to town",
                  [("Christmas horror", ["christmas"]), ("Krampus & demons", ["krampus", "demon"]), ("Snowed in", ["snow", "blizzard"])]),
    "winter": ("Cabin Fever", "Snowed in with something out there",
               [("Snowed in", ["snow", "blizzard"]), ("Cabins in the woods", ["cabin"]), ("Survival horror", ["survival"])]),
    "spring": ("Folk Horror Spring", "Things grow back. Not all of them should.",
               [("Folk horror", ["folk horror"]), ("Cults", ["cult"]), ("Creepy kids", ["evil child"])]),
    "summer": ("Summer Camp Slashers", "Don't go in the lake",
               [("Summer camp", ["summer camp"]), ("Slashers", ["slasher"]), ("Something in the water", ["shark", "lake"])]),
    "autumn": ("Back to School Scares", "Detention is the least of your worries",
               [("High school horror", ["high school"]), ("Slashers", ["slasher"])]),
}
HORROR = "27"
WEB = os.path.join(os.path.dirname(__file__), "web")


def season_for(d=None):
    d = d or datetime.date.today()
    m, day = d.month, d.day
    if m == 10:
        return "halloween"
    if m == 11:
        return "fall"
    if m == 12 or (m == 1 and day <= 6):
        return "christmas"
    if m <= 2:
        return "winter"
    if m <= 5:
        return "spring"
    if m <= 8:
        return "summer"
    return "autumn"


def _keyword(name):
    """TMDB keyword id for a name (exact match preferred), remembered for a month."""
    def load():
        res = tmdb.get("/search/keyword", query=name).get("results", [])
        hit = next((r for r in res if r["name"].lower() == name.lower()), res[0] if res else None)
        return hit["id"] if hit else None
    return arr.cached(f"tmdb:kw:{name}", 30 * 86400, load)


def _discover(**params):
    q = {"include_adult": "false", "with_genres": HORROR, "sort_by": "popularity.desc", "vote_count.gte": 40, **params}
    key = "tmdb:seasonal:" + ":".join(f"{k}={v}" for k, v in sorted(q.items()))
    d = arr.cached(key, 6 * 3600, lambda: tmdb.get("/discover/movie", **q))
    return tmdb.shape(d.get("results", []), "movie", resolve=False)


def channel(user=None, season=None, hour=None):
    season = season if season in CHANNELS else season_for()
    title, subtitle, spec = CHANNELS[season]
    rows = []
    if user is not None:  # what's already on their server comes first
        try:
            import library
            mine = library.rows(user, "Horror")
            items = [x for r in mine["rows"] for x in r["items"]]
            if len(items) >= 4:
                rows.append({"key": "server", "title": f"Horror on {mine['name']}", "items": items[:30]})
        except Exception:  # no Plex/Jellyfin linked, or no Horror genre there
            pass
    if hour is not None and (hour >= 22 or hour < 4):
        rows.append({"key": "late", "title": "Can't sleep? Short horror", "items": _discover(**{"with_runtime.lte": 95, "vote_count.gte": 300})})
    for i, (rtitle, words) in enumerate(spec):
        ids = [str(k) for k in (_keyword(w) for w in words) if k]
        if ids:
            rows.append({"key": f"k{i}", "title": rtitle, "items": _discover(with_keywords="|".join(ids))})
    rows.append({"key": "classics", "title": "All-time horror classics", "items": _discover(sort_by="vote_average.desc", **{"vote_count.gte": 2000})})
    seen, out = set(), []
    for r in rows:  # each film once, in its first row
        items = []
        for x in r["items"]:
            k = (x["type"], x.get("tmdb") or x.get("id"))
            if k not in seen:
                seen.add(k)
                items.append(x)
        if len(items) >= 4:
            out.append({**r, "type": "movie", "sort": "popular", "cat": None, "items": items[:20]})
    hero = next((x for r in out for x in r["items"] if x.get("backdrop") and x.get("overview")), None)
    art = f"/season/{season}/scene.png" if os.path.exists(os.path.join(WEB, "season", season, "scene.png")) else None
    return {"season": season, "title": title, "subtitle": subtitle, "art": art, "hero": hero, "rows": out,
            "late": hour is not None and (hour >= 22 or hour < 4)}
