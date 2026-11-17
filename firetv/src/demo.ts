// Demo mode: the app without a NuniFlix server, for trying it out (and for Amazon's app reviewers, who must never
// need the owner's own server). Answers the same API calls with made-up data. The titles are Blender's open movies
// (Creative Commons); only Big Buck Bunny "is on the server", and it plays a public test stream of it.
import type {Item, LiveChannel, LiveProgram} from './models';

export const DEMO = 'demo';
const STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // Big Buck Bunny, H.264 + AAC in MPEG-TS
const BBB_LENGTH = 596;

type Q = Record<string, string | undefined>;

const movies: Item[] = [
  {type: 'movie', id: 10378, tmdb: 10378, title: 'Big Buck Bunny', year: 2008, status: 'available', rating: 6.5, runtime: 10, genres: ['Animation', 'Comedy'],
    overview: 'A giant rabbit with a heart bigger than himself gets even with three bullying rodents.'},
  {type: 'movie', id: 45745, tmdb: 45745, title: 'Sintel', year: 2010, status: 'none', rating: 7.1, runtime: 15, genres: ['Animation', 'Fantasy'],
    overview: 'A lonely young woman searches for the baby dragon she once rescued.'},
  {type: 'movie', id: 133701, tmdb: 133701, title: 'Tears of Steel', year: 2012, status: 'none', rating: 6.0, runtime: 12, genres: ['Science Fiction'],
    overview: 'A group of warriors and scientists gather in Amsterdam to stage a crucial event from the past.'},
  {type: 'movie', id: 9761, tmdb: 9761, title: 'Elephants Dream', year: 2006, status: 'none', rating: 5.8, runtime: 11, genres: ['Animation', 'Science Fiction'],
    overview: 'Two strange characters explore a capricious and seemingly infinite machine.'},
  {type: 'movie', id: 358332, tmdb: 358332, title: 'Cosmos Laundromat', year: 2015, status: 'none', rating: 6.6, runtime: 12, genres: ['Animation', 'Comedy'],
    overview: 'On a desolate island, a suicidal sheep meets a mysterious salesman who offers him the gift of a lifetime.'},
  {type: 'movie', id: 610150, tmdb: 610150, title: 'Spring', year: 2019, status: 'none', rating: 7.0, runtime: 8, genres: ['Animation', 'Fantasy'],
    overview: 'A shepherd girl and her dog face ancient spirits to keep the cycle of life going.'},
];

const requested = new Set<number>();
const item = (it: Item): Item => (it.id != null && requested.has(it.id) && it.status === 'none' ? {...it, status: 'pending'} : it);
const all = () => movies.map(item);
const provider = {id: '0', name: 'Open Movies'};

function program(now: number): LiveProgram {
  const start = Math.floor(now / BBB_LENGTH) * BBB_LENGTH;
  const m = movies[0];
  return {id: 'bbb', kind: 'movie', ext: m.id, tmdb: m.tmdb, title: m.title, overview: m.overview, start, end: start + BBB_LENGTH, slotEnd: start + BBB_LENGTH};
}

function channel(now: number): LiveChannel {
  const p = program(now);
  const next = {...p, start: p.end, end: p.end + BBB_LENGTH, slotEnd: p.end + BBB_LENGTH};
  return {key: 'open', number: 1, name: 'Open Movies', tagline: 'Bunnies, all day', kind: 'movie', programs: [p, next]};
}

/** The demo's answer to one API call (path without /api), as [status, body]. */
export function demo(method: string, path: string, query: Q, body?: Record<string, unknown>): [number, unknown] {
  const now = Date.now() / 1000;
  const p = path.split('?')[0];
  if (p === '/health') return [200, {ok: true}];
  if (p === '/auth/options') return [200, {jellyfin: false, plex: false, discord: false, name: 'NuniFlix'}];
  if (p === '/auth/logout') return [200, {ok: true}];
  if (p === '/me') return [200, {name: 'Demo Viewer', admin: false, owner: false, perms: {can_movie: true, can_tv: true}, has4k: {movie: false, tv: false}, prefs: {}}];
  if (p === '/me/prefs') return [200, {ok: true}];
  if (p === '/profiles') return [200, {profiles: []}];
  if (p === '/browse/providers') return [200, {enabled: true, providers: [provider]}];
  if (p.startsWith('/browse/provider/') && p.endsWith('/rows')) {
    const list = all();
    return [200, {hero: list[0], rows: [
      {key: 'popular', title: 'Popular', type: 'all', sort: 'popular', items: list},
      {key: 'new', title: 'New and noteworthy', type: 'all', sort: 'new', items: [...list].reverse()},
    ], genres: [{key: 'animation', title: 'Animation'}]}];
  }
  if (p.startsWith('/browse/provider/') || p === '/library') {
    return [200, {results: query.page && query.page !== '1' ? [] : all(), page: Number(query.page ?? 1), total_pages: 1}];
  }
  if (p === '/shelves') return [200, {shelves: []}];
  if (p === '/library/source') return [200, {source: 'jellyfin', name: 'Demo library'}];
  if (p === '/library/rows') return [200, {source: 'jellyfin', name: 'Demo library', hero: movies[0], rows: [{key: 'added', title: 'Recently added', type: 'all', sort: 'added', items: [movies[0]], page: 1}], genres: []}];
  if (p === '/home/foryou') return [200, {rows: []}];
  if (p === '/requests' && method === 'GET') {
    return [200, {requests: movies.filter((m) => requested.has(m.id!)).map((m, i) => ({id: i + 1, type: 'movie', media_id: m.id, tmdb: m.tmdb, title: m.title, year: m.year, is4k: false, status: 'pending'}))}];
  }
  if (p === '/requests' && method === 'POST') {
    requested.add(Number(body?.id));
    return [200, {request: {status: 'pending'}}];
  }
  const m = p.match(/^\/item\/movie\/(\d+)$/);
  if (m) {
    const found = movies.find((x) => x.id === Number(m[1]));
    return found ? [200, item(found)] : [404, {detail: 'Not found.'}];
  }
  if (p.startsWith('/extra/')) return [200, {cast: [], recommendations: all().slice(1, 5)}];
  if (p.startsWith('/watch/')) return [200, {}];
  if (p.startsWith('/play/movie/')) return [200, {source: 'jellyfin', items: [{id: 'bbb', title: 'Big Buck Bunny', resume: 0, duration: BBB_LENGTH, watched: false}]}];
  if (p === '/play/start') return [200, {url: STREAM, session: 'demo'}];
  if (p === '/play/progress') return [200, {ok: true}];
  if (p === '/live') return [200, {now, source: 'jellyfin', channels: [channel(now)]}];
  if (p.startsWith('/live/')) {
    const pr = program(now);
    return [200, {now, program: pr, offset: now - pr.start, next: channel(now).programs[1], channel: {key: 'open', name: 'Open Movies', tagline: 'Bunnies, all day'}, stream: {url: STREAM, session: 'demo'}}];
  }
  if (p === '/search' || p.endsWith('/search')) {
    const q = (query.q ?? '').toLowerCase();
    return [200, {results: all().filter((x) => (x.title ?? '').toLowerCase().includes(q))}];
  }
  return [404, {detail: 'Not in the demo.'}];
}
