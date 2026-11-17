// Home in sections (YourFlix · Seasonal genres · Streaming), YourFlix, your own Plex/Jellyfin library, the shelves,
// and "Who's watching?". Mirrors apple/Sources/Views/BrowseViews.swift, ShelfViews.swift and ProfileViews.swift.
import React, {useCallback, useEffect, useState} from 'react';
import {BackHandler, ScrollView, StyleSheet, Text, View} from 'react-native';
import {api, errorText} from '../api';
import {DiscoverPage, ForYouRow, GenreRef, Item, itemKey, LibrarySource, MyRequest, PlexProfile, Provider, requestItem, Row, RowsPage, Shelf, ShelfPage} from '../models';
import {DEVICE_NAME, useStore} from '../store';
import {M, ServiceTheme, serviceTheme, upper} from '../theme';
import {Background, Button, C, ErrorView, Focusable, Heading, ItemRow, Loading, Picture} from '../components/ui';
import {Hero} from './Browse';

const firstName = (n: string) => n.split(' ')[0] || n;
const W = M.serviceTile.width;
const H = M.serviceTile.height;

function Section({title, theme, children}: {title: string; theme: ServiceTheme; children: React.ReactNode}) {
  return (
    <View style={{marginBottom: M.spacing}}>
      <Heading theme={theme} style={{marginBottom: 14}}>
        {title}
      </Heading>
      <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: M.spacing - 8}}>{children}</View>
    </View>
  );
}

// ---------- home

export function ServicesScreen() {
  const store = useStore();
  const theme = store.theme;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [lib, setLib] = useState<LibrarySource | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, sh, ls] = await Promise.all([
      api.get<{enabled: boolean; providers: Provider[]}>('/browse/providers').catch((e) => e as Error),
      api.get<{shelves: Shelf[]}>('/shelves').catch(() => null),
      api.get<LibrarySource>('/library/source').catch(() => null),
    ]);
    if (p instanceof Error) setError(errorText(p));
    else {
      setProviders(p.providers);
      setError(null);
    }
    setShelves(sh?.shelves ?? []);
    setLib(ls?.source ? ls : null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{padding: M.gutter, paddingTop: 50}}>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 20}}>
          <Text style={{color: theme.brand, fontSize: 72, fontWeight: '900', flex: 1}}>{upper(theme, store.brand)}</Text>
          <Button title="Search" icon="⌕" onPress={() => store.push({name: 'search'})} theme={theme} />
          <Button title="Settings" icon="⚙︎" onPress={() => store.push({name: 'settings'})} theme={theme} />
        </View>
        <Text style={{color: C.dim, fontSize: 30, marginTop: 8, marginBottom: M.spacing}}>
          {store.me ? `Hi ${firstName(store.me.name)}. What do you feel like watching?` : 'What do you feel like watching?'}
        </Text>

        <Section title="YourFlix" theme={theme}>
          <Focusable onPress={() => store.push({name: 'yourflix'})} corner={14} preferred>
            <YourFlixTile theme={theme} />
          </Focusable>
          <Focusable onPress={() => store.push({name: 'live'})} corner={14}>
            <LiveTile theme={theme} />
          </Focusable>
        </Section>

        {shelves.length ? (
          <Section title="Seasonal genres" theme={theme}>
            {shelves.map((s) => (
              <Focusable key={s.key} onPress={() => store.push({name: 'shelf', shelf: s})} corner={14}>
                <ShelfTile shelf={s} theme={theme} />
              </Focusable>
            ))}
          </Section>
        ) : null}

        <Section title="Streaming" theme={theme}>
          {lib ? (
            <Focusable onPress={() => store.push({name: 'library'})} corner={14}>
              <LibraryTile source={lib} />
            </Focusable>
          ) : null}
          {providers.map((p) => (
            <Focusable key={p.id} onPress={() => store.push({name: 'service', provider: p})} corner={14}>
              <ServiceTile provider={p} />
            </Focusable>
          ))}
        </Section>
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : loaded && providers.length === 0 ? (
          <Text style={{color: C.dim, fontSize: 26}}>Browsing by service needs a TMDB key. The owner can add one in NuniFlix → Settings.</Text>
        ) : !loaded ? (
          <Loading height={200} />
        ) : null}
      </ScrollView>
    </Background>
  );
}

function ServiceTile({provider}: {provider: Provider}) {
  const t = serviceTheme(provider.name);
  return (
    <View style={[styles.tile, {backgroundColor: t.background[0]}]}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: t.accent, opacity: 0.35, left: '45%'}]} />
      <Picture uri={provider.logo} style={{width: H * 0.55, height: H * 0.55, borderRadius: 12}} />
      <Text style={{color: '#FFFFFF', fontSize: 28, fontWeight: '700', flex: 1}} numberOfLines={2}>
        {provider.name}
      </Text>
    </View>
  );
}

function YourFlixTile({theme}: {theme: ServiceTheme}) {
  return (
    <View style={[styles.tile, {backgroundColor: theme.accent}]}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: theme.background[0], opacity: 0.6, left: '55%'}]} />
      <View>
        <Text style={{color: '#FFFFFF', fontSize: 34, fontWeight: '900'}}>{upper(theme, 'YourFlix')}</Text>
        <Text style={{color: 'rgba(255,255,255,0.85)', fontSize: 20}}>Your channel</Text>
      </View>
    </View>
  );
}

function LiveTile({theme}: {theme: ServiceTheme}) {
  return (
    <View style={[styles.tile, {backgroundColor: '#14141C'}]}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: theme.accent, opacity: 0.25, right: '60%'}]} />
      <View style={{width: 18, height: 18, borderRadius: 9, backgroundColor: C.red}} />
      <View style={{flex: 1}}>
        <Text style={{color: '#FFFFFF', fontSize: 34, fontWeight: '900'}}>{upper(theme, 'Live TV')}</Text>
        <Text style={{color: 'rgba(255,255,255,0.8)', fontSize: 20}}>Channels from your library</Text>
      </View>
    </View>
  );
}

function LibraryTile({source}: {source: LibrarySource}) {
  const plex = source.source === 'plex';
  return (
    <View style={[styles.tile, {backgroundColor: plex ? '#1F1F1F' : '#5B6FD0'}]}>
      {!plex ? <View style={[StyleSheet.absoluteFill, {backgroundColor: '#AA5CC3', right: '50%'}]} /> : null}
      <Text style={{color: plex ? '#E5A00D' : '#FFFFFF', fontSize: H * 0.4, fontWeight: '900', width: H * 0.55, textAlign: 'center'}}>
        {plex ? '❯' : '▲'}
      </Text>
      <View style={{flex: 1}}>
        <Text style={{color: '#FFFFFF', fontSize: 28, fontWeight: '700'}}>{source.name ?? 'Your library'}</Text>
        <Text style={{color: 'rgba(255,255,255,0.7)', fontSize: 20}}>Your library</Text>
      </View>
    </View>
  );
}

function ShelfTile({shelf, theme}: {shelf: Shelf; theme: ServiceTheme}) {
  return (
    <View style={{width: W, height: H, borderRadius: 14, overflow: 'hidden', backgroundColor: '#0B0B12', justifyContent: 'flex-end'}}>
      <Picture uri={shelf.art} style={StyleSheet.absoluteFill} />
      <View style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', backgroundColor: 'rgba(0,0,0,0.6)'}} />
      <View style={{padding: 14}}>
        <Text style={{color: '#FFFFFF', fontSize: 28, fontWeight: '900'}} numberOfLines={1}>
          {upper(theme, shelf.title)}
        </Text>
        {shelf.tagline ? (
          <Text style={{color: 'rgba(255,255,255,0.8)', fontSize: 18}} numberOfLines={1}>
            {shelf.tagline}
          </Text>
        ) : null}
      </View>
      {shelf.now ? (
        <View style={{position: 'absolute', top: 10, right: 10, backgroundColor: theme.accent, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4}}>
          <Text style={{color: theme.onAccent, fontSize: 16, fontWeight: '900'}}>IN SEASON</Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------- YourFlix: continue watching, your requests, "because you watched", your library

export function YourFlixScreen() {
  const store = useStore();
  const theme: ServiceTheme = {...store.theme, tile: 'poster'};
  const [requests, setRequests] = useState<MyRequest[]>([]);
  const [lib, setLib] = useState<RowsPage | null>(null);
  const [forYou, setForYou] = useState<ForYouRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, l, f] = await Promise.all([
      api.get<{requests: MyRequest[]}>('/requests', {scope: 'mine'}).catch((e) => e as Error),
      api.get<RowsPage>('/library/rows').catch(() => null), // null when no Plex/Jellyfin is linked
      api.get<{rows: ForYouRow[]}>('/home/foryou').catch(() => null),
    ]);
    setForYou(f?.rows ?? []);
    if (r instanceof Error) {
      if (!l) setError(errorText(r));
    } else {
      setRequests(r.requests);
      setError(null);
    }
    setLib(l);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pick = (f: (r: MyRequest) => boolean): Item[] => {
    const seen = new Set<string>();
    return requests.filter(f).flatMap((r) => {
      const it: Item = {...requestItem(r), status: r.status === 'pending' ? 'pending' : r.media_status ?? 'processing', progress: r.progress};
      const k = itemKey(it);
      if (seen.has(k)) return []; // a show asked for twice (two seasons) shows once
      seen.add(k);
      return [it];
    });
  };
  const ready = (r: MyRequest) => ['available', 'partial'].includes(r.media_status ?? '');
  const rows: [string, Item[]][] = (
    [
      ['Ready to watch', pick((r) => r.status === 'approved' && ready(r))],
      ['On the way', pick((r) => r.status === 'approved' && !ready(r))],
      ['Waiting for approval', pick((r) => r.status === 'pending')],
      ["Didn't go through", pick((r) => r.status === 'denied' || r.status === 'failed')],
    ] as [string, Item[]][]
  ).filter(([, l]) => l.length > 0);
  const resume = lib?.rows.find((r) => r.key === 'resume');
  const libHero = lib?.hero ?? lib?.rows.flatMap((r) => r.items).find((it) => it.backdrop);

  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingVertical: 50}}>
        <View style={{paddingHorizontal: M.gutter, marginBottom: M.spacing}}>
          <Text style={{color: theme.brand, fontSize: 68, fontWeight: '900'}}>{upper(theme, 'YourFlix')}</Text>
          <Text style={{color: C.dim, fontSize: 28}}>{store.me ? `${firstName(store.me.name)}'s channel` : 'Your channel'}</Text>
        </View>
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : !loaded ? (
          <Loading />
        ) : (
          <>
            {resume ? <ItemRow title={resume.title} theme={theme} items={resume.items} preferredFirst /> : null}
            {rows.map(([title, list], i) => (
              <ItemRow key={title} title={`${title}  ·  ${list.length}`} theme={theme} items={list} preferredFirst={!resume && i === 0} />
            ))}
            {forYou.map((row) => (
              <ItemRow key={row.title} title={row.title} theme={theme} items={row.items} />
            ))}
            {rows.length === 0 && !lib ? (
              <Focusable preferred corner={12} style={{marginHorizontal: M.gutter - 8, alignSelf: 'flex-start'}}>
                <Text style={{color: C.dim, fontSize: 28, padding: 8}}>Nothing requested yet. Find something on a service and choose Request.</Text>
              </Focusable>
            ) : null}
            {lib ? (
              <>
                <LibraryDoor name={lib.name ?? 'your library'} hero={libHero} theme={theme} preferred={!resume && rows.length === 0} />
                {lib.genres?.length ? <LibraryGenres genres={lib.genres} theme={theme} title="Your genres" /> : null}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </Background>
  );
}

function LibraryDoor({name, hero, theme, preferred}: {name: string; hero?: Item; theme: ServiceTheme; preferred?: boolean}) {
  const store = useStore();
  return (
    <View style={{paddingHorizontal: M.gutter, marginTop: M.spacing / 2}}>
      <Heading theme={theme} style={{marginBottom: 12}}>
        Browse
      </Heading>
      <Focusable onPress={() => store.push({name: 'library'})} corner={Math.max(theme.corner, 8)} scale={1.02} preferred={preferred}>
        <View style={{height: H * 1.8, borderRadius: Math.max(theme.corner, 8), overflow: 'hidden', justifyContent: 'flex-end'}}>
          <Picture uri={hero?.backdrop ?? hero?.poster} style={StyleSheet.absoluteFill} />
          <View style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', backgroundColor: 'rgba(0,0,0,0.6)'}} />
          <View style={{padding: 24}}>
            <Text style={{color: '#FFFFFF', fontSize: 44, fontWeight: '800'}}>Everything on {name}  ›</Text>
            <Text style={{color: 'rgba(255,255,255,0.8)', fontSize: 24}}>Ready to watch right now</Text>
          </View>
        </View>
      </Focusable>
    </View>
  );
}

function LibraryGenres({genres, theme, title}: {genres: GenreRef[]; theme: ServiceTheme; title: string}) {
  const store = useStore();
  return (
    <View style={{paddingHorizontal: M.gutter, marginTop: M.spacing / 2}}>
      <Heading theme={theme} style={{marginBottom: 12}}>
        {title}
      </Heading>
      <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: M.spacing / 2}}>
        {genres.map((g, i) => (
          <Focusable key={g.key} corner={Math.max(theme.corner, 8)} onPress={() => store.push({name: 'library', genre: g.key})}>
            <View style={{width: W, height: H, borderRadius: Math.max(theme.corner, 8), backgroundColor: theme.accent, justifyContent: 'flex-end', padding: 18, overflow: 'hidden'}}>
              <View style={[StyleSheet.absoluteFill, {backgroundColor: '#000000', opacity: 0.12 + (i % 4) * 0.1}]} />
              <Text style={{color: '#FFFFFF', fontSize: 30, fontWeight: '700'}}>{upper(theme, g.title)}</Text>
            </View>
          </Focusable>
        ))}
      </View>
    </View>
  );
}

// ---------- your Plex/Jellyfin library (or one genre of it), laid out like a service page

async function moreLibrary(row: Row, n: number, genre?: string): Promise<Item[]> {
  if (row.key === 'resume') return [];
  const q: Record<string, string> = {type: row.type ?? 'all', page: String(n)};
  const g = row.cat ?? genre;
  if (g) q.genre = g;
  try {
    const d = await api.get<DiscoverPage>('/library', q);
    return d.page <= d.total_pages ? d.results : [];
  } catch {
    return [];
  }
}

export function LibraryScreen({genre}: {genre?: string}) {
  const store = useStore();
  const theme: ServiceTheme = {...store.theme, tile: 'poster'};
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPage(await api.get<RowsPage>('/library/rows', genre ? {genre} : {}));
    } catch (e) {
      setError(errorText(e));
    }
  }, [genre]);

  useEffect(() => {
    load();
  }, [load]);

  const query: Record<string, string> = {type: 'all'};
  if (genre) query.genre = genre;
  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingVertical: 40}}>
        <View style={{flexDirection: 'row', alignItems: 'baseline', gap: 20, paddingHorizontal: M.gutter, marginBottom: 20}}>
          <Text style={{color: '#FFFFFF', fontSize: 52, fontWeight: '800'}}>{upper(theme, genre ?? 'Everything')}</Text>
          <Text style={{color: C.dim, fontSize: 30}}>on {page?.name ?? 'your library'}</Text>
        </View>
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : page ? (
          <>
            {page.hero ? <Hero item={page.hero} theme={theme} preferred /> : null}
            {page.rows.map((row, i) => (
              <ItemRow
                key={row.key}
                title={row.title}
                theme={theme}
                items={row.items}
                startPage={row.page}
                preferredFirst={!page.hero && i === 0}
                more={(n) => moreLibrary(row, n, genre)}
              />
            ))}
            <View style={{paddingHorizontal: M.gutter, flexDirection: 'row'}}>
              <Button title="See everything" icon="▦" onPress={() => store.push({name: 'browse', title: genre ?? 'Everything', query})} theme={theme} />
            </View>
            {page.genres?.length ? <LibraryGenres genres={page.genres} theme={theme} title="Genres" /> : null}
          </>
        ) : (
          <Loading height={500} />
        )}
      </ScrollView>
    </Background>
  );
}

// ---------- a shelf: its pixel-art scene as a banner, then rows

export function ShelfScreen({shelf}: {shelf: Shelf}) {
  const store = useStore();
  const theme: ServiceTheme = {...store.theme, tile: 'poster'};
  const [page, setPage] = useState<ShelfPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPage(await api.get<ShelfPage>(`/shelves/${shelf.key}`));
    } catch (e) {
      setError(errorText(e));
    }
  }, [shelf.key]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingBottom: M.spacing * 2}}>
        <View style={{height: H * 2.6, justifyContent: 'flex-end', marginBottom: M.spacing / 2}}>
          <Picture uri={shelf.art} style={StyleSheet.absoluteFill} />
          <View style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: '50%', backgroundColor: 'rgba(0,0,0,0.55)'}} />
          <View style={{padding: M.gutter, paddingBottom: 30}}>
            <Text style={{color: '#FFFFFF', fontSize: 80, fontWeight: '900'}}>{upper(theme, shelf.title)}</Text>
            {shelf.tagline ? <Text style={{color: 'rgba(255,255,255,0.85)', fontSize: 28}}>{shelf.tagline}</Text> : null}
          </View>
        </View>
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : page ? (
          page.rows.length === 0 ? (
            <Focusable preferred corner={12} style={{marginHorizontal: M.gutter - 8, alignSelf: 'flex-start'}}>
              <Text style={{color: C.dim, fontSize: 26, padding: 8}}>
                Nothing on this shelf yet. Browsing needs a TMDB key (the owner adds it in Settings).
              </Text>
            </Focusable>
          ) : (
            page.rows.map((row, i) => <ItemRow key={row.key} title={row.title} theme={theme} items={row.items} preferredFirst={i === 0} />)
          )
        ) : (
          <Loading height={400} />
        )}
      </ScrollView>
    </Background>
  );
}

// ---------- "Who's watching?": which Plex Home profile this TV is

export function ProfilePicker() {
  const store = useStore();
  const theme = store.theme;
  const [asking, setAsking] = useState<PlexProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back: out of the PIN pad, or keep whoever is signed in now
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (asking) {
        setAsking(null);
        setError(null);
      } else store.setChoosingProfile(false);
      return true;
    });
    return () => sub.remove();
  }, [asking, store]);

  async function pick(p: PlexProfile, pin?: string) {
    if (p.current) {
      store.setChoosingProfile(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {user: p.id, device: DEVICE_NAME};
      if (pin) body.pin = pin;
      const [text] = await api.post('/profiles/switch', body);
      await store.didSignIn(text, false);
      store.setChoosingProfile(false);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }

  return (
    <Background theme={theme} style={StyleSheet.absoluteFill}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: 'rgba(0,0,0,0.45)'}]} />
      {asking ? (
        <PinPad
          profile={asking}
          busy={busy}
          error={error}
          done={(pin) => pick(asking, pin)}
          cancel={() => {
            setAsking(null);
            setError(null);
          }}
        />
      ) : (
        <View style={{flex: 1, justifyContent: 'center', alignItems: 'center', gap: 50}}>
          <Text style={{color: '#FFFFFF', fontSize: 64, fontWeight: '900'}}>Who's watching?</Text>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 50, maxWidth: 1700}}>
            {store.profiles.map((p, i) => (
              <Focusable key={p.id} onPress={() => (p.pin && !p.current ? setAsking(p) : pick(p))} corner={20} preferred={p.current || (i === 0 && !store.profiles.some((x) => x.current))} disabled={busy}>
                <View style={{width: 260, alignItems: 'center', gap: 14, padding: 12}}>
                  <Avatar profile={p} size={200} />
                  <Text style={{color: '#FFFFFF', fontSize: 30, fontWeight: '700'}} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={{color: 'rgba(255,255,255,0.7)', fontSize: 20}}>
                    {[p.current ? 'Signed in' : null, p.admin ? 'Owner' : null, p.kid ? 'Kids' : null, p.pin ? '🔒 PIN' : null].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Focusable>
            ))}
          </View>
          {busy ? <Loading height={60} /> : null}
          {error ? <Text style={{color: C.red, fontSize: 26}}>{error}</Text> : null}
        </View>
      )}
    </Background>
  );
}

function Avatar({profile, size}: {profile: PlexProfile; size: number}) {
  return (
    <View style={{width: size, height: size, borderRadius: size / 2, backgroundColor: '#E5A00D', justifyContent: 'center', alignItems: 'center', overflow: 'hidden'}}>
      <Text style={{color: '#1F1F1F', fontSize: size * 0.42, fontWeight: '900'}}>{profile.name.slice(0, 1).toUpperCase()}</Text>
      {profile.thumb ? <Picture uri={profile.thumb} style={[StyleSheet.absoluteFill, {backgroundColor: 'transparent'}]} /> : null}
    </View>
  );
}

/** Four digits, typed with the remote on an on-screen pad. */
function PinPad({profile, busy, error, done, cancel}: {
  profile: PlexProfile;
  busy: boolean;
  error: string | null;
  done: (pin: string) => void;
  cancel: () => void;
}) {
  const [digits, setDigits] = useState('');
  useEffect(() => {
    if (error) setDigits('');
  }, [error]);
  const tap = (k: string) => {
    if (k === '⌫') setDigits((d) => d.slice(0, -1));
    else if (k === '✕') cancel();
    else if (digits.length < 4) {
      const d = digits + k;
      setDigits(d);
      if (d.length === 4) done(d);
    }
  };
  return (
    <View style={{flex: 1, justifyContent: 'center', alignItems: 'center', gap: 30}}>
      <Avatar profile={profile} size={140} />
      <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '800'}}>Enter {profile.name}'s PIN</Text>
      <View style={{flexDirection: 'row', gap: 24}}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{width: 26, height: 26, borderRadius: 13, backgroundColor: i < digits.length ? '#FFFFFF' : 'rgba(255,255,255,0.2)'}} />
        ))}
      </View>
      {error ? <Text style={{color: C.red, fontSize: 26}}>{error}</Text> : null}
      <View style={{gap: 18}}>
        {[
          ['1', '2', '3'],
          ['4', '5', '6'],
          ['7', '8', '9'],
          ['⌫', '0', '✕'],
        ].map((row) => (
          <View key={row.join()} style={{flexDirection: 'row', gap: 18}}>
            {row.map((k) => (
              <Focusable key={k} onPress={() => tap(k)} corner={16} disabled={busy} preferred={k === '1'}>
                <View style={{width: 130, height: 90, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.14)', justifyContent: 'center', alignItems: 'center'}}>
                  <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '700'}}>{k}</Text>
                </View>
              </Focusable>
            ))}
          </View>
        ))}
      </View>
      <Text style={{color: C.dim, fontSize: 20}}>Back to choose someone else</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {width: W, height: H, borderRadius: 14, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 18},
});
