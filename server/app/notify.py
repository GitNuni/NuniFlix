"""Notifications: channel webhooks (Discord and Discord-style, like Fluxer), Discord DMs (through the bot), and Web Push to phones.

Everything is fire-and-forget on a small thread pool, so a slow Discord never holds up a request.
VAPID keys for Web Push are generated on first use and kept in the data folder.
"""
import base64, datetime, json, os
from concurrent.futures import ThreadPoolExecutor

import httpx

import arr, store

DISCORD = "https://discord.com/api/v10"
VAPID_KEY = os.path.join(store.DATA, "vapid-private.pem")
VAPID_PUB = os.path.join(store.DATA, "vapid-public.txt")
COLORS = {"pending": 0xFF9F0A, "approved": 0x0A84FF, "available": 0x30D158, "denied": 0xFF453A,
          "failed": 0xFF453A, "issue": 0xFF9F0A, "resolved": 0x30D158, "test": 0xE50914}
_http = httpx.Client(timeout=10)
_pool = ThreadPoolExecutor(2)


def send(event, title, body, users=(), admins=False, poster=None, url="/", channel=False, media=None, fields=()):
    """users: people to tell personally (push / Discord DM). admins: every admin too.
    channel: may be posted in the webhook channel, if the owner picked this event for it.
    media: (type, id) so Discord posts get the synopsis, backdrop, year, genres... fields: [(name, value)] shown as a table."""
    _pool.submit(_send, event, title, body, list(users), admins, poster, url, channel, media, list(fields))


def _details(media):
    """Synopsis, artwork and facts for a title (from the library / Radarr / Sonarr lookup)."""
    try:
        return arr.item(*media)
    except Exception:
        return None


def _send(event, title, body, users, admins, poster, url, channel, media=None, fields=()):
    try:
        cfg = store.config()
        n = cfg["notify"]
        info = _details(media) if media else None
        site = cfg.get("site_url")
        if media and site:
            url = f"{site.rstrip('/')}/?item={media[0]}:{media[1]}"
        rich = {"info": info, "fields": fields, "link": url if url.startswith("http") else None}
        if media:
            url = f"/?item={media[0]}:{media[1]}"
        targets = {u["id"]: u for u in users if u}
        if admins:
            for u in store.q("select * from users where (owner=1 or admin=1) and blocked=0"):
                targets.setdefault(u["id"], u)
        if channel and n["events"].get(event):
            for h in n["webhooks"]:  # every channel: Discord, Fluxer...
                try:
                    webhook(h["url"], event, title, body, poster, **rich)
                except httpx.HTTPError as e:
                    print(f"webhook {h.get('name')} failed:", type(e).__name__, flush=True)
        bot = cfg["discord"]["bot_token"]
        for u in targets.values():
            p = store.prefs(u)
            if n["push"] and p["push"]:
                push(u["id"], title, body, url)
            dc = store.q1("select id from identities where user_id=? and source='discord'", (u["id"],)) if n["dm"] and p["discord"] and bot else None
            if dc:
                dm(bot, dc["id"][3:], event, title, body, poster, **rich)
    except Exception as e:  # never let a notification break anything else
        print("notify failed:", type(e).__name__, e, flush=True)


def _embed(event, title, body, poster, info=None, fields=(), link=None):
    e = {"title": title[:256], "description": body or "", "color": COLORS.get(event, 0x888888),
         "footer": {"text": store.app_name()}, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    rows = [{"name": k, "value": str(v)[:1024], "inline": len(str(v)) < 40} for k, v in fields if v not in (None, "")]
    if info:
        ov = (info.get("overview") or "").strip()
        if ov:
            short = ov if len(ov) <= 500 else ov[:500].rsplit(" ", 1)[0] + "…"
            e["description"] = short + ("\n\n" + body if body else "")
        facts = [str(info["year"]) if info.get("year") else None, ", ".join(info.get("genres") or []) or None,
                 f"{info['runtime']} min" if info.get("runtime") else None, info.get("certification"),
                 f"★ {float(info['rating']):.1f}" if info.get("rating") else None, info.get("network") or info.get("studio")]
        facts = " · ".join(f for f in facts if f)
        if facts:
            rows.append({"name": "Details", "value": facts[:1024], "inline": False})
        poster = poster or info.get("poster")
        if info.get("backdrop"):
            e["image"] = {"url": info["backdrop"]}
        if info.get("imdb"):
            rows.append({"name": "Links", "value": f"[IMDb](https://www.imdb.com/title/{info['imdb']}/)"
                         + (f" · [TMDB](https://www.themoviedb.org/{'movie' if info['type'] == 'movie' else 'tv'}/{info['tmdb']})" if info.get("tmdb") else ""),
                         "inline": False})
    if rows:
        e["fields"] = rows[:25]
    if poster:
        e["thumbnail"] = {"url": poster}
    if link:
        e["url"] = link
    return e


def webhook(url, event, title, body, poster=None, **rich):
    r = _http.post(url, json={"username": store.app_name(), "embeds": [_embed(event, title, body, poster, **rich)]})
    return r.status_code < 300


def dm(bot, discord_id, event, title, body, poster=None, **rich):
    h = {"Authorization": "Bot " + bot}
    ch = _http.post(f"{DISCORD}/users/@me/channels", headers=h, json={"recipient_id": discord_id})
    if ch.status_code == 200:
        _http.post(f"{DISCORD}/channels/{ch.json()['id']}/messages", headers=h,
                   json={"embeds": [_embed(event, title, body, poster, **rich)]})


# ---------- Web Push ----------
def vapid_public():
    if not os.path.exists(VAPID_KEY):
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid01
        v = Vapid01()
        v.generate_keys()
        v.save_key(VAPID_KEY)
        os.chmod(VAPID_KEY, 0o600)
        raw = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        with open(VAPID_PUB, "w") as f:
            f.write(base64.urlsafe_b64encode(raw).decode().rstrip("="))
    with open(VAPID_PUB) as f:
        return f.read().strip()


def push(user_id, title, body, url="/"):
    from pywebpush import WebPushException, webpush
    vapid_public()
    for s in store.q("select * from push_subs where user_id=?", (user_id,)):
        try:
            webpush({"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                    json.dumps({"title": title, "body": body, "url": url}),
                    vapid_private_key=VAPID_KEY, vapid_claims={"sub": "mailto:noreply@nuniflix.app"}, timeout=10)
        except WebPushException as e:
            if e.response is not None and e.response.status_code in (404, 410):  # phone unsubscribed
                store.run("delete from push_subs where endpoint=?", (s["endpoint"],))
