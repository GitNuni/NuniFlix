// What the NuniFlix server sends (snake_case, as on the wire). Mirrors apple/Sources/Core/Models.swift.

export interface Me {
  name: string;
  admin: boolean;
  owner: boolean;
  perms: {can_movie?: boolean; can_tv?: boolean; request_4k?: boolean};
  has4k: {movie: boolean; tv: boolean};
  prefs?: {theme?: string};
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
}

export interface GenreRef {
  key: string;
  title: string;
}

export interface RowsPage {
  hero?: Item;
  rows: Row[];
  genres?: GenreRef[];
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
