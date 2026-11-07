"""SQLite storage + config.json. Everything lives in NF_DATA (/data in the container)."""
import contextlib, copy, hashlib, json, os, secrets, sqlite3, threading, time

DATA = os.environ.get("NF_DATA", "/data")
DB_PATH = os.path.join(DATA, "nuniflix.db")
CONFIG_PATH = os.path.join(DATA, "config.json")

DEFAULTS = {
    "radarr": {"url": "", "key": "", "profile": 10, "root": "/movies", "availability": "released"},
    "sonarr": {"url": "", "key": "", "profile": 10, "root": "/tvlocal", "season_folders": True},
    # optional second servers for 4K copies
    "radarr4k": {"url": "", "key": "", "profile": 0, "root": "", "availability": "released"},
    "sonarr4k": {"url": "", "key": "", "profile": 0, "root": "", "season_folders": True},
    "jellyfin": {"url": "", "key": "", "public_url": ""},
    "plex": {"url": "", "token": ""},  # token: for the owner's server only, saved when the owner signs in with Plex
    # Discord sign-in: OAuth app + the server people must be in (and the role they need, if set).
    # The bot token is optional; it only lets setup list the server's roles.
    "discord": {"client_id": "", "secret": "", "guild_id": "", "role_id": "", "bot_token": ""},
    "tmdb": {"key": "", "region": "US"},
    # where notifications go: a Discord channel webhook, Discord DMs (needs the bot token), and phone push
    # `events` = which ones get posted in the channel (personal notes always go to the people involved)
    "notify": {"webhook": "", "dm": True, "push": True,
               "events": {"pending": True, "approved": False, "denied": False, "available": True, "added": False,
                          "issue": True, "resolved": False, "failed": True}},
    # default request limits for everyone who isn't an admin: N requests per D days (0 = no limit)
    "quotas": {"movie_limit": 0, "movie_days": 7, "tv_limit": 0, "tv_days": 7},
    # The owner's own Jellyfin account ids. Being a Jellyfin admin is NOT enough to be a NuniFlix admin.
    "admin_jellyfin_ids": [],
    "jellyfin_login": True,
    "plex_login": True,
    "discord_login": False,
    "auto_approve": False,  # True = everyone's requests go straight to Radarr/Sonarr
    "auto_next": True,  # request the next season when someone finishes one (they can opt out under Notifications)
    "brand": "Nuni",  # the first half of the app's name: "Nuni" + "Flix". A friend running their own can make it "Max" -> MaxFlix
    "home_off": [],  # Home sections the owner turned off for everyone (on top of each person's own layout)
    "show_requester": True,  # posters show the first name of whoever asked for it
    "office_on": True,  # the Office: a live building of what's playing, downloading and being searched for
    "office_names": False,  # everyone sees who's watching what in the Office (admins always do; otherwise "someone")
    "swipe_on": True,  # Swipe (trailers, right to request) for everyone the owner allows
    "match_on": True,  # Movie Match links (swipe the owner's library with someone)
    # Discord only opens accounts that already have a Plex or Jellyfin sign-in (so it's someone with access to the owner's server)
    "discord_needs_link": True,
    "site_url": "",  # NuniFlix's own address; Discord redirects and links in posts use it (blank = whatever address is in use)
    "setup_done": False,
}
SECRET_FIELDS = ("key", "secret", "bot_token", "webhook", "token")

# per-person permissions; None = follow the global setting
PERM_DEFAULTS = {"can_movie": True, "can_tv": True, "request_4k": False, "auto_movie": None, "auto_tv": None,
                 "movie_limit": None, "movie_days": None, "tv_limit": None, "tv_days": None,
                 "can_swipe": True, "can_match": True}

SCHEMA = """
create table if not exists users(
  id text primary key, name text not null, source text not null,
  owner int not null default 0, admin int not null default 0, blocked int not null default 0,
  created real not null, last_seen real);
create table if not exists sessions(
  token_hash text primary key, user_id text not null references users(id) on delete cascade,
  device text, created real not null, last_seen real not null);
create table if not exists requests(
  id integer primary key autoincrement, type text not null, ext_id integer not null, tmdb_id integer,
  title text not null, year integer, poster text, seasons text,
  user_id text not null references users(id), status text not null, note text,
  created real not null, updated real not null, decided_by text);
create index if not exists req_item on requests(type, ext_id);
create index if not exists req_user on requests(user_id);
create table if not exists issues(
  id integer primary key autoincrement, type text not null, ext_id integer not null, title text not null, poster text,
  season integer, episode integer, kind text not null, message text, user_id text not null references users(id),
  status text not null default 'open', reply text, created real not null, updated real not null, resolved_by text);
create index if not exists issue_status on issues(status);
create table if not exists identities(
  id text primary key, user_id text not null references users(id) on delete cascade,
  source text not null, name text, owner int not null default 0, created real not null, last_seen real);
create index if not exists ident_user on identities(user_id);
create table if not exists swipes(
  user_id text not null references users(id) on delete cascade, type text not null, tmdb integer not null,
  action text not null, created real not null, primary key(user_id, type, tmdb));
create table if not exists auto_next(
  user_id text not null, tvdb integer not null, season integer not null, created real not null, primary key(user_id, tvdb, season));
create table if not exists match_sessions(
  code text primary key, host_id text not null references users(id) on delete cascade, guest_name text,
  deck text not null, created real not null, expires real not null);
create table if not exists match_votes(
  code text not null references match_sessions(code) on delete cascade, who text not null, tmdb integer not null,
  vote text not null, created real not null, primary key(code, who, tmdb));
create table if not exists push_subs(
  endpoint text primary key, user_id text not null references users(id) on delete cascade,
  p256dh text not null, auth text not null, created real not null);
"""

_lock = threading.RLock()
_db = None


def db():
    global _db
    if _db is None:
        os.makedirs(DATA, exist_ok=True)
        _db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        _db.row_factory = sqlite3.Row
        _db.execute("pragma journal_mode=wal")
        _db.execute("pragma foreign_keys=on")
        fresh = not _db.execute("select 1 from sqlite_master where name='identities'").fetchone()
        _db.executescript(SCHEMA)
        if fresh:  # before linking existed every user was exactly one sign-in account
            _db.execute("insert or ignore into identities select id, id, source, name, owner, created, last_seen from users")
        cols = {r[1] for r in _db.execute("pragma table_info(requests)")}
        if "episodes" not in cols:  # single-episode requests: seasons = [n], episodes = [e, ...]
            _db.execute("alter table requests add column episodes text")
        if "done_at" not in cols:  # when it was first seen in the library (home drops it a few days later)
            _db.execute("alter table requests add column done_at real")
        for col, typ in (("is4k", "int not null default 0"), ("profile", "int"), ("root", "text")):
            if col not in cols:  # 4K copy; admin-picked quality profile / folder
                _db.execute(f"alter table requests add column {col} {typ}")
        ucols = {r[1] for r in _db.execute("pragma table_info(users)")}
        if "perms" not in ucols:
            _db.execute("alter table users add column perms text")
        if "prefs" not in ucols:  # notification choices
            _db.execute("alter table users add column prefs text")
        if "identity" not in {r[1] for r in _db.execute("pragma table_info(sessions)")}:  # which sign-in account opened it
            _db.execute("alter table sessions add column identity text")
        mcols = {r[1] for r in _db.execute("pragma table_info(match_sessions)")}
        for col in ("host_key", "guest_key"):  # each side of a movie match is a device, not an account
            if col not in mcols:
                _db.execute(f"alter table match_sessions add column {col} text")
    return _db


def q(sql, args=()):
    with _lock:
        return [dict(r) for r in db().execute(sql, args).fetchall()]


def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def run(sql, args=()):
    with _lock:
        return db().execute(sql, args).lastrowid


def change(sql, args=()):
    """Run an update/delete; how many rows it touched (0 = someone else got there first)."""
    with _lock:
        return db().execute(sql, args).rowcount


_tx_depth = threading.local()


@contextlib.contextmanager
def tx():
    """All-or-nothing: the statements inside either all happen or none do. Nests (inner blocks join the outer one)."""
    with _lock:
        depth = getattr(_tx_depth, "n", 0)
        if depth == 0:
            db().execute("begin immediate")
        _tx_depth.n = depth + 1
        try:
            yield
        except BaseException:
            _tx_depth.n = depth
            if depth == 0:
                db().execute("rollback")
            raise
        _tx_depth.n = depth
        if depth == 0:
            db().execute("commit")


# ---------- config ----------
_cfg_cache = (None, None)  # (mtime, parsed file)


def _saved():
    global _cfg_cache
    try:
        mtime = os.stat(CONFIG_PATH).st_mtime_ns
    except FileNotFoundError:
        return {}
    if _cfg_cache[0] != mtime:
        with open(CONFIG_PATH) as f:
            _cfg_cache = (mtime, json.load(f))
    return json.loads(json.dumps(_cfg_cache[1]))  # callers may modify their copy


def config():
    saved = _saved()
    out = {}
    for k, v in copy.deepcopy(DEFAULTS).items():
        out[k] = {**v, **saved.get(k, {})} if isinstance(v, dict) else saved.get(k, v)
    out["notify"]["events"] = {**DEFAULTS["notify"]["events"], **(saved.get("notify", {}).get("events") or {})}
    return out


def save_config(cfg):
    with _lock:
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cfg, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONFIG_PATH)


def public_config(cfg=None):
    """Config with secrets replaced by <field>_set flags (safe to send to an admin's browser)."""
    cfg = cfg or config()
    out = {}
    for k, v in cfg.items():
        if isinstance(v, dict):
            out[k] = {f: val for f, val in v.items() if f not in SECRET_FIELDS}
            for f in SECRET_FIELDS:
                if f in v:
                    out[k][f + "_set"] = bool(v[f])
        else:
            out[k] = v
    return out


# ---------- sessions ----------
def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


SESSION_DAYS = 90


def new_session(user_id, device=None, identity=None):
    token = secrets.token_urlsafe(32)
    now = time.time()
    run("insert into sessions(token_hash,user_id,device,created,last_seen,identity) values(?,?,?,?,?,?)",
        (_hash(token), user_id, (device or "")[:80], now, now, identity))
    return token


def session_user(token):
    if not token:
        return None
    h = _hash(token)
    u = q1("select u.*, s.last_seen as s_seen from sessions s join users u on u.id=s.user_id where s.token_hash=?", (h,))
    now = time.time()
    if not u or u["blocked"] or now - u.pop("s_seen") > SESSION_DAYS * 86400:  # unused for 90 days = signed out
        return None
    if now - (u["last_seen"] or 0) > 300:  # activity times only need to be roughly right
        run("update sessions set last_seen=? where token_hash=?", (now, h))
        run("update users set last_seen=? where id=?", (now, u["id"]))
    return u


def end_session(token):
    run("delete from sessions where token_hash=?", (_hash(token),))


def tidy():
    """Drop what nobody can use any more: sign-ins idle past the 90-day cookie, expired movie matches."""
    now = time.time()
    run("delete from sessions where last_seen<?", (now - SESSION_DAYS * 86400,))
    run("delete from match_sessions where expires<?", (now,))


# ---------- people and their sign-in accounts ----------
# A person (users row) can have one Plex, one Jellyfin and one Discord account linked (identities rows).
# Signing in with any of them opens the same person. Owner = any linked account is the server owner,
# so a Discord linked to the owner's Plex/Jellyfin opens the owner's account.
SOURCES = {"plex": "Plex", "jellyfin": "Jellyfin", "discord": "Discord"}


class LinkError(Exception):
    pass


def _refresh(uid):
    run("update users set owner=(select coalesce(max(owner),0) from identities where user_id=?) where id=?", (uid, uid))


def login_identity(ident):
    """ident = {id, name, source, owner}. Returns the person it belongs to, creating one the first time."""
    now = time.time()
    with tx():
        row = q1("select * from identities where id=?", (ident["id"],))
        if row:
            run("update identities set name=?, owner=?, last_seen=? where id=?", (ident["name"], int(ident["owner"]), now, ident["id"]))
            uid = row["user_id"]
            if uid == ident["id"]:  # the account they started with: keep the display name current
                run("update users set name=? where id=?", (ident["name"], uid))
        else:
            uid = ident["id"]
            if q1("select 1 from users where id=?", (uid,)):  # that id now belongs to someone it was unlinked from
                uid += "~" + secrets.token_hex(3)
            run("insert into users(id,name,source,owner,admin,blocked,created,last_seen) values(?,?,?,0,0,0,?,?)",
                (uid, ident["name"], ident["source"], now, now))
            run("insert into identities values(?,?,?,?,?,?,?)", (ident["id"], uid, ident["source"], ident["name"], int(ident["owner"]), now, now))
        _refresh(uid)
        return q1("select * from users where id=?", (uid,))


def upsert_user(uid, name, source, owner):
    return login_identity({"id": uid, "name": name, "source": source, "owner": owner})


def identities(uid):
    return q("select id, source, name, owner from identities where user_id=? order by created", (uid,))


def _clash(src_uid, dst_uid):
    have = {r["source"] for r in identities(dst_uid)}
    both = have & {r["source"] for r in identities(src_uid)}
    if both:
        raise LinkError(f"Both already have a {SOURCES[both.pop()]} account. Unlink one first.")


def merge_users(src, dst):
    """Fold person `src` into `dst`: requests, problem reports, devices, sign-in accounts. `src` is removed."""
    with tx():
        run("delete from swipes where user_id=? and exists(select 1 from swipes s where s.user_id=? and s.type=swipes.type and s.tmdb=swipes.tmdb)", (src, dst))
        run("delete from sessions where user_id=?", (src,))
        for table in ("requests", "issues", "push_subs", "identities", "swipes"):
            run(f"update {table} set user_id=? where user_id=?", (dst, src))
        run("update requests set decided_by=? where decided_by=?", (dst, src))
        run("insert or ignore into auto_next select ?, tvdb, season, created from auto_next where user_id=?", (dst, src))
        run("delete from auto_next where user_id=?", (src,))
        run("update users set admin=max(admin,(select admin from users where id=?)) where id=?", (src, dst))
        run("delete from users where id=?", (src,))
        _refresh(dst)


def link_identity(uid, ident):
    """Attach a sign-in account the person just proved they own. If it was already its own person, merge them in."""
    now = time.time()
    with tx():
        row = q1("select * from identities where id=?", (ident["id"],))
        if row and row["user_id"] == uid:
            raise LinkError("That account is already linked to you.")
        if row:
            other, me = q1("select * from users where id=?", (row["user_id"],)), q1("select * from users where id=?", (uid,))
            # linking merges the two people, so it must never hand someone else's owner/admin powers to a regular account
            if other and ((other["owner"] and not me["owner"]) or (is_admin(other) and not is_admin(me))):
                raise LinkError("That account belongs to someone else's NuniFlix.")
            _clash(row["user_id"], uid)
            merge_users(row["user_id"], uid)
            run("update identities set name=?, owner=?, last_seen=? where id=?", (ident["name"], int(ident["owner"]), now, ident["id"]))
        else:
            if q1("select 1 from identities where user_id=? and source=?", (uid, ident["source"])):
                raise LinkError(f"You already have a {SOURCES[ident['source']]} account linked. Unlink it first.")
            run("insert into identities values(?,?,?,?,?,?,?)", (ident["id"], uid, ident["source"], ident["name"], int(ident["owner"]), now, now))
        _refresh(uid)


def unlink_identity(uid, ident_id):
    with tx():
        row = q1("select * from identities where id=? and user_id=?", (ident_id, uid))
        if not row:
            raise LinkError("That account isn't linked to you.")
        if len(identities(uid)) < 2:
            raise LinkError("That's your only way to sign in. Link another account first.")
        run("delete from identities where id=?", (ident_id,))
        run("delete from sessions where identity=?", (ident_id,))  # devices signed in with it are signed out
        _refresh(uid)


def is_admin(u):
    return bool(u and (u["owner"] or u["admin"]))


def perms(u):
    return {**PERM_DEFAULTS, **json.loads(u.get("perms") or "{}")}


HOME_ROWS = ("featured", "requests", "office", "discover", "foryou", "movies", "tv", "trending", "theaters", "popular", "upcoming", "genres")
HOME_DEFAULT = ["featured", "requests", "office", "movies", "trending", "discover", "theaters", "popular", "upcoming", "tv", "genres"]
HOME_V3 = ["theaters", "popular", "upcoming", "genres"]  # the "find something new" rows


def prefs(u):
    p = {"push": True, "discord": True, "auto_next": True, "autoplay": True, "home": HOME_DEFAULT, **json.loads(u.get("prefs") or "{}")}
    if p.get("home_v", 1) < 2 and "featured" not in p["home"]:  # layouts saved before the big featured banner existed get it on top
        p["home"] = ["featured", *p["home"]]
    if p.get("home_v", 1) < 3:  # layouts saved before the browse rows existed get them at the end
        p["home"] = [*p["home"], *[k for k in HOME_V3 if k not in p["home"]]]
    if p.get("home_v", 1) < 4 and "office" not in p["home"]:  # the Office card goes right under the banner
        at = p["home"].index("featured") + 1 if "featured" in p["home"] else 0
        p["home"] = [*p["home"][:at], "office", *p["home"][at:]]
    return p


def app_name(cfg=None):
    return ((cfg or config()).get("brand") or "Nuni") + "Flix"
