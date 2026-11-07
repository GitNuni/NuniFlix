"""Find a title on the owner's Jellyfin / Plex so the app can link straight to it ("Play on Jellyfin").

Jellyfin uses the API key from setup. Plex uses a token for the owner's server only (not their plex.tv account),
saved the first time the owner signs in with Plex.
"""
import urllib.parse

import httpx

import arr, store

_http = httpx.Client(timeout=8, headers={"Accept": "application/json"})


def _match(ids, kind, tmdb, tvdb):
    return (tmdb and str(tmdb) in ids.get("tmdb", ())) or (kind == "tv" and tvdb and str(tvdb) in ids.get("tvdb", ()))


def jellyfin(kind, tmdb, tvdb, title, year):
    c = store.config()["jellyfin"]
    if not (c["url"] and c["key"]):
        return None
    base, h = c["url"].rstrip("/"), {"Authorization": f'MediaBrowser Token="{c["key"]}"'}
    sid = arr.cached("jf:serverid", 86400, lambda: _http.get(base + "/System/Info/Public").json().get("Id"))
    items = _http.get(base + "/Items", headers=h, params={
        "Recursive": "true", "IncludeItemTypes": "Movie" if kind == "movie" else "Series", "SearchTerm": title,
        "Fields": "ProviderIds,ProductionYear", "Limit": 25}).json().get("Items", [])
    for it in items:
        p = {k.lower(): (v,) for k, v in (it.get("ProviderIds") or {}).items()}
        if _match(p, kind, tmdb, tvdb):
            return f"{(c['public_url'] or c['url']).rstrip('/')}/web/#/details?id={it['Id']}&serverId={sid}"
    return None


def plex(kind, tmdb, tvdb, title, year):
    c = store.config()["plex"]
    if not (c["url"] and c.get("token")):
        return None
    base, h = c["url"].rstrip("/"), {"X-Plex-Token": c["token"]}
    machine = arr.cached("plex:machine", 86400, lambda: _http.get(base + "/identity").json()["MediaContainer"]["machineIdentifier"])
    d = _http.get(base + "/hubs/search", headers=h, params={"query": title, "includeGuids": 1, "limit": 20}).json()
    for hub in d.get("MediaContainer", {}).get("Hub", []):
        for m in hub.get("Metadata", []):
            if m.get("type") != ("movie" if kind == "movie" else "show"):
                continue
            ids = {}
            for g in m.get("Guid", []):
                src, _, val = g.get("id", "").partition("://")
                ids[src] = ids.get(src, ()) + (val,)
            if _match(ids, kind, tmdb, tvdb):
                key = urllib.parse.quote(f"/library/metadata/{m['ratingKey']}", safe="")
                return f"https://app.plex.tv/desktop/#!/server/{machine}/details?key={key}"
    return None


def library_movies():
    """TMDB ids of every movie on Jellyfin and Plex (catches anything Radarr doesn't manage)."""
    def load():
        ids = set()
        c = store.config()
        jf, px = c["jellyfin"], c["plex"]
        try:
            if jf["url"] and jf["key"]:
                r = _http.get(jf["url"].rstrip("/") + "/Items", headers={"Authorization": f'MediaBrowser Token="{jf["key"]}"'}, timeout=60,
                              params={"Recursive": "true", "IncludeItemTypes": "Movie", "Fields": "ProviderIds", "Limit": 50000}).json()
                ids |= {int(v) for i in r.get("Items", []) for k, v in (i.get("ProviderIds") or {}).items() if k.lower() == "tmdb" and str(v).isdigit()}
        except (httpx.HTTPError, ValueError, KeyError):
            pass
        try:
            if px["url"] and px.get("token"):
                base, h = px["url"].rstrip("/"), {"X-Plex-Token": px["token"]}
                for sec in _http.get(base + "/library/sections", headers=h).json()["MediaContainer"].get("Directory", []):
                    if sec.get("type") != "movie":
                        continue
                    for m in _http.get(f"{base}/library/sections/{sec['key']}/all", headers=h, params={"includeGuids": 1}, timeout=60
                                       ).json()["MediaContainer"].get("Metadata", []):
                        ids |= {int(g["id"][7:]) for g in m.get("Guid", []) if g.get("id", "").startswith("tmdb://") and g["id"][7:].isdigit()}
        except (httpx.HTTPError, ValueError, KeyError):
            pass
        return ids
    return arr.cached("library:movies", 1800, load)


def links(kind, ext_id, sources):
    """{'jellyfin': url|None, 'plex': url|None} for the services in `sources`."""
    def load():
        it = arr.item(kind, ext_id)
        args = (kind, it.get("tmdb"), it.get("tvdb"), it["title"], it.get("year"))
        out = {}
        for name, fn in (("jellyfin", jellyfin), ("plex", plex)):
            try:
                out[name] = fn(*args)
            except (httpx.HTTPError, ValueError, KeyError):
                out[name] = None
        return out
    found = arr.cached(f"watch:{kind}:{ext_id}", 600, load)
    return {k: v for k, v in found.items() if k in sources}
