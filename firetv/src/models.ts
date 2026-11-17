// What the NuniFlix server sends (snake_case, as on the wire). Mirrors apple/Sources/Core/Models.swift.

export interface Me {
  name: string;
  admin: boolean;
  owner: boolean;
  perms: {can_movie?: boolean; can_tv?: boolean; request_4k?: boolean};
  has4k: {movie: boolean; tv: boolean};
  prefs?: {theme?: string; hosts?: string}; // hosts: both | vesper | off (Live TV)
}

export function canRequest(me: Me, type: string): boolean {
  return me.admin || (type === 'movie' ? me.perms.can_movie ?? true : me.perms.can_tv ?? true);
}

export function can4K(me: Me, type: string): boolean {
  return (type === 'movie' ? me.has4k.movie : me.has4k.tv) && (me.admin || me.perms.request_4k === true);
}

export interface AuthOptions {
  jellyfin: boolean;
  plex: boolean;
  discord: boolean;
  fluxer?: boolean;
  name?: string;
}

export interface Provider {
  id: string;
  name: string;
  logo?: string;
}

export interface Season {
  n: number;
  episodes?: number;
  have?: number;
  monitored?: boolean;
}

export const seasonComplete = (s: Season) => (s.episodes ?? 0) > 0 && (s.have ?? 0) >= (s.episodes ?? 0);

/** A movie or show: catalog tile, or (with more filled in) the detail page. `id` is the TMDB id for movies,
 *  the TVDB id for shows (missing: a show not looked up yet). */
export interface Item {
  type: string; // movie | tv
  id?: number;
  tmdb?: number;
  title?: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  genres?: string[];
  status?: string; // none | pending | processing | partial | available
  progress?: number;
  requested_by?: string;
  runtime?: number;
  certification?: string;
  network?: string;
  seasons?: Season[];
  status4k?: string;
  streaming?: Provider[];
}

export const itemKey = (it: Item) => `${it.type}:${it.tmdb ?? it.id ?? 0}`;

export interface Row {
  key: string;
  title: string;
  type?: string; // movie | tv | all
  sort: string;
  cat?: string;
  items: Item[];
  page?: number; // pages already in `items` (library rows start with two)
}

export interface GenreRef {
  key: string;
  title: string;
}

export interface RowsPage {
  hero?: Item;
  rows: Row[];
  genres?: GenreRef[];
  name?: string; // the library page: "Plex" / "Jellyfin"
  source?: string;
}

export interface DiscoverPage {
  results: Item[];
  page: number;
  total_pages: number;
}

export interface Extras {
  trailer?: string;
  cast: {id: number; name: string; photo?: string; role?: string}[];
  collection?: {name?: string; items: Item[]};
  logo?: string;
  recommendations: Item[];
}

export interface MyRequest {
  id: number;
  type: string;
  media_id?: number;
  tmdb?: number;
  title?: string;
  year?: number;
  poster?: string;
  seasons?: number[];
  is4k: boolean;
  status: string; // pending | approved | denied | failed
  media_status?: string;
  progress?: number;
  note?: string;
}

export const requestItem = (r: MyRequest): Item => ({
  type: r.type,
  id: r.media_id,
  tmdb: r.tmdb,
  title: r.title,
  year: r.year,
  poster: r.poster,
});

export interface TVCode {
  code: string;
  state: string;
  url: string;
  link: string;
  expires: number;
}

// ---------- watching in the app (server: player.py) ----------
export interface PlayItem {
  id: string;
  title: string;
  season?: number | null;
  episode?: number | null;
  resume: number; // seconds
  duration: number;
  watched: boolean;
}

export interface PlayOptions {
  source: string; // plex | jellyfin
  items: PlayItem[];
}

export interface StreamStart {
  url: string;
  session: string;
}

/** Worth offering "Resume or start over": some real progress, and not already in the end credits. */
export const canResume = (e: PlayItem) => e.resume > 15 && (e.duration === 0 || e.resume < e.duration * 0.95);
export const episodeCode = (e: PlayItem) => (e.season != null && e.episode != null ? `S${e.season} · E${e.episode}` : null);

/** "1:02:03" / "4:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

// ---------- home sections ----------
/** Permanent themed tiles: Kids, Christmas, Halloween, Horror... (server: shelves.py). `art` is a path on the server. */
export interface Shelf {
  key: string;
  title: string;
  tagline?: string;
  art?: string;
  now?: boolean; // in season
}

export interface ShelfPage {
  title: string;
  tagline?: string;
  art?: string;
  hero?: Item;
  rows: Row[];
}

/** Which of the owner's servers this person watches from (null source: none linked). */
export interface LibrarySource {
  source?: string | null; // plex | jellyfin
  name?: string | null;
}

export interface ForYouRow {
  title: string;
  items: Item[];
}

/** One profile in the owner's Plex Home (server: /api/profiles). */
export interface PlexProfile {
  id: string;
  name: string;
  thumb?: string;
  pin: boolean;
  admin: boolean;
  kid: boolean;
  current: boolean;
}

// ---------- live channels (server: channels.py, host.py) ----------
export interface LiveProgram {
  id: string;
  kind: string;
  ext?: number;
  tmdb?: number;
  title?: string;
  sub?: string;
  show?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  start: number; // unix seconds
  end: number;
  slotEnd: number;
}

export interface LiveChannel {
  key: string;
  number: number;
  name: string;
  tagline: string;
  kind: string;
  takeover?: string;
  programs: LiveProgram[];
}

/** Vesper, the host: her mood follows the clock (day / dusk / evil). Lucy, her sister, sometimes joins for a scene. */
export interface HostSays {
  name: string;
  mood: string;
  line: string;
  lines?: string[];
  guest?: {name: string; mood: string};
  banter?: {who: string; line: string}[];
}

export interface LiveLineup {
  now: number;
  source: string;
  channels: LiveChannel[];
  takeover?: string;
  host?: HostSays;
}

export interface LiveTune {
  now: number;
  program: LiveProgram;
  offset: number; // seconds into the programme; negative: it starts in that long (the channel's ident until then)
  next?: LiveProgram;
  channel?: {key: string; name: string; tagline: string; takeover?: string};
  host?: HostSays;
  stream?: StreamStart; // already started at the right point
}

export const programLabel = (p: LiveProgram) => (p.show ? `${p.show}: ${p.title ?? ''}` : p.title ?? '');
export const onNow = (ch: LiveChannel, now = Date.now() / 1000) => ch.programs.find((p) => p.slotEnd > now);
/** The viewer's offset from UTC in minutes (east positive), for takeover days and the host's mood. */
export const liveTZ = () => String(-new Date().getTimezoneOffset());

/** "7:30 PM" */
export function hm(unix: number): string {
  const d = new Date(unix * 1000);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
