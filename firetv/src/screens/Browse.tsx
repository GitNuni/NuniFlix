// Home (pick a service), YourFlix, a service's home, its sections and full grids, search, settings.
// Mirrors apple/Sources/Views/BrowseViews.swift.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FlatList, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {api, errorText} from '../api';
import {DiscoverPage, Extras, GenreRef, Item, itemKey, MyRequest, Provider, requestItem, Row, RowsPage} from '../models';
import {useStore} from '../store';
import {APP_THEMES, M, ServiceTheme, serviceTheme, tileSize, upper} from '../theme';
import {Background, Button, C, ErrorView, Focusable, Heading, ItemCard, ItemRow, Loading, Picture, StatusBadge} from '../components/ui';

const firstName = (n: string) => n.split(' ')[0] || n;

// ---------- home: which service?

export function ServicesScreen() {
  const store = useStore();
  const theme = store.theme;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await api.get<{enabled: boolean; providers: Provider[]}>('/browse/providers');
      setProviders(p.providers);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
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
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : loaded && providers.length === 0 ? (
          <ErrorView message="Browsing by service needs a TMDB key. The owner can add one in NuniFlix → Settings." theme={theme} />
        ) : !loaded ? (
          <Loading />
        ) : null}
        <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: M.spacing - 8}}>
          <Focusable onPress={() => store.push({name: 'yourflix'})} corner={14} preferred>
            <YourFlixTile theme={theme} />
          </Focusable>
          {providers.map((p) => (
            <Focusable key={p.id} onPress={() => store.push({name: 'service', provider: p})} corner={14}>
              <ServiceTile provider={p} />
            </Focusable>
          ))}
        </View>
      </ScrollView>
    </Background>
  );
}

function ServiceTile({provider}: {provider: Provider}) {
  const t = serviceTheme(provider.name);
  return (
    <View style={[styles.tile, {backgroundColor: t.background[0]}]}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: t.accent, opacity: 0.35, left: '45%'}]} />
      <Picture uri={provider.logo} style={{width: M.serviceTile.height * 0.55, height: M.serviceTile.height * 0.55, borderRadius: 12}} />
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
        <Text style={{color: 'rgba(255,255,255,0.85)', fontSize: 20}}>What you asked for</Text>
      </View>
    </View>
  );
}

// ---------- YourFlix: everything you've requested

export function YourFlixScreen() {
  const store = useStore();
  const theme = {...store.theme, tile: 'poster' as const};
  const [requests, setRequests] = useState<MyRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{requests: MyRequest[]}>('/requests', {scope: 'mine'});
      setRequests(r.requests);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
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

  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingVertical: 50}}>
        <View style={{paddingHorizontal: M.gutter, marginBottom: M.spacing}}>
          <Text style={{color: theme.brand, fontSize: 68, fontWeight: '900'}}>{upper(theme, 'YourFlix')}</Text>
          <Text style={{color: C.dim, fontSize: 28}}>
            {store.me ? `Everything ${firstName(store.me.name)} asked for` : 'Everything you asked for'}
          </Text>
        </View>
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : !loaded ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Text style={{color: C.dim, fontSize: 28, paddingHorizontal: M.gutter}}>
            Nothing requested yet. Find something on a service and choose Request.
          </Text>
        ) : (
          rows.map(([title, list], i) => (
            <ItemRow key={title} title={`${title}  ·  ${list.length}`} theme={theme} items={list} preferredFirst={i === 0} />
          ))
        )}
      </ScrollView>
    </Background>
  );
}

// ---------- a service's home

async function moreRows(provider: Provider, row: Row, n: number, fallbackType = 'all', fallbackCat?: string): Promise<Item[]> {
  const q: Record<string, string> = {type: row.type ?? fallbackType, sort: row.sort, page: String(n), quick: 'true'};
  const cat = row.cat ?? fallbackCat;
  if (cat) q.cat = cat;
  try {
    const d = await api.get<DiscoverPage>(`/browse/provider/${provider.id}`, q);
    return d.page <= d.total_pages ? d.results : [];
  } catch {
    return [];
  }
}

const DOOR_KEYS = new Set(['movies', 'shows']);

export function ServiceHomeScreen({provider}: {provider: Provider}) {
  const store = useStore();
  const theme = serviceTheme(provider.name);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPage(await api.get<RowsPage>(`/browse/provider/${provider.id}/rows`, {type: 'all'}));
    } catch (e) {
      setError(errorText(e));
    }
  }, [provider.id]);

  useEffect(() => {
    load();
  }, [load]);

  const doors = page?.rows.filter((r) => DOOR_KEYS.has(r.key)) ?? [];
  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingBottom: M.spacing * 2}}>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: M.gutter, paddingTop: 30}}>
          <Picture uri={provider.logo} style={{width: 70, height: 70, borderRadius: 12}} />
          <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '800', flex: 1}}>{provider.name}</Text>
          <Button title="Search" icon="⌕" onPress={() => store.push({name: 'search', provider})} theme={theme} />
        </View>
        {error ? (
          <ErrorView message={error} retry={load} theme={theme} />
        ) : page ? (
          <>
            {page.hero ? <Hero item={page.hero} theme={theme} preferred /> : null}
            {page.rows
              .filter((r) => !DOOR_KEYS.has(r.key))
              .map((row, i) => (
                <ItemRow
                  key={row.key}
                  title={row.title}
                  theme={theme}
                  items={row.items}
                  preferredFirst={!page.hero && i === 0}
                  more={(n) => moreRows(provider, row, n)}
                />
              ))}
            {doors.length ? <BrowseDoors provider={provider} rows={doors} theme={theme} /> : null}
            {page.genres?.length ? <GenreGrid provider={provider} genres={page.genres} theme={theme} /> : null}
          </>
        ) : (
          <Loading height={500} />
        )}
      </ScrollView>
    </Background>
  );
}

function GenreGrid({provider, genres, theme}: {provider: Provider; genres: GenreRef[]; theme: ServiceTheme}) {
  const store = useStore();
  return (
    <View style={{paddingHorizontal: M.gutter, marginTop: M.spacing / 2}}>
      <Heading theme={theme} style={{marginBottom: 12}}>
        Genres
      </Heading>
      <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: M.spacing / 2}}>
        {genres.map((g, i) => (
          <Focusable
            key={g.key}
            corner={Math.max(theme.corner, 8)}
            onPress={() => store.push({name: 'section', provider, title: g.title, type: 'all', cat: g.key})}>
            <View
              style={{
                width: M.serviceTile.width,
                height: M.serviceTile.height,
                borderRadius: Math.max(theme.corner, 8),
                backgroundColor: theme.accent,
                justifyContent: 'flex-end',
                padding: 18,
                overflow: 'hidden',
              }}>
              <View style={[StyleSheet.absoluteFill, {backgroundColor: '#000000', opacity: 0.12 + (i % 4) * 0.1}]} />
              <Text style={{color: '#FFFFFF', fontSize: 30, fontWeight: '700'}}>{upper(theme, g.title)}</Text>
            </View>
          </Focusable>
        ))}
      </View>
    </View>
  );
}

function BrowseDoors({provider, rows, theme}: {provider: Provider; rows: Row[]; theme: ServiceTheme}) {
  const store = useStore();
  return (
    <View style={{paddingHorizontal: M.gutter, marginTop: M.spacing / 2}}>
      <Heading theme={theme} style={{marginBottom: 12}}>
        Browse
      </Heading>
      <View style={{flexDirection: 'row', gap: M.spacing / 2}}>
        {rows.map((row) => (
          <Focusable
            key={row.key}
            corner={Math.max(theme.corner, 8)}
            style={{flex: 1}}
            scale={1.03}
            onPress={() =>
              store.push({name: 'section', provider, title: row.title, type: row.type ?? (row.key === 'movies' ? 'movie' : 'tv')})
            }>
            <View style={{height: M.serviceTile.height * 1.6, borderRadius: Math.max(theme.corner, 8), overflow: 'hidden', justifyContent: 'flex-end'}}>
              <Picture uri={row.items.find((it) => it.backdrop)?.backdrop} style={StyleSheet.absoluteFill} />
              <View style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', backgroundColor: 'rgba(0,0,0,0.55)'}} />
              <Text style={{color: '#FFFFFF', fontSize: 44, fontWeight: '800', padding: 20}}>{upper(theme, row.title)}  ›</Text>
            </View>
          </Focusable>
        ))}
      </View>
    </View>
  );
}

export function Hero({item, theme, preferred}: {item: Item; theme: ServiceTheme; preferred?: boolean}) {
  const store = useStore();
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    if (item.tmdb) api.get<Extras>(`/extra/${item.type}/${item.tmdb}`).then((x) => setLogo(x.logo ?? null), () => {});
  }, [item.type, item.tmdb]);
  const meta = [item.year && String(item.year), item.rating ? `★ ${item.rating.toFixed(1)}` : null, ...(item.genres ?? [])]
    .filter(Boolean)
    .join('  ·  ');
  return (
    <View style={{height: M.heroHeight, justifyContent: 'flex-end', marginBottom: M.spacing / 2}}>
      <Picture uri={item.backdrop} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, {backgroundColor: theme.background[0], opacity: 0.35}]} />
      <View style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', backgroundColor: theme.background[0], opacity: 0.75}} />
      <View style={{paddingHorizontal: M.gutter, paddingBottom: M.spacing, gap: 14, maxWidth: 1200}}>
        {logo ? (
          <Picture uri={logo} style={{width: 560, height: 160}} fit />
        ) : (
          <Text style={{color: '#FFFFFF', fontSize: 64, fontWeight: '900'}}>{item.title}</Text>
        )}
        <Text style={{color: 'rgba(255,255,255,0.8)', fontSize: 24, fontWeight: '600'}}>{meta}</Text>
        {item.overview ? (
          <Text style={{color: 'rgba(255,255,255,0.88)', fontSize: 24}} numberOfLines={3}>
            {item.overview}
          </Text>
        ) : null}
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 20}}>
          <Button
            title={item.status === 'available' ? 'Watch' : 'More info'}
            icon={item.status === 'available' ? '▶' : 'ⓘ'}
            onPress={() => store.push({name: 'item', item, theme})}
            theme={theme}
            primary
            preferred={preferred}
          />
          <StatusBadge status={item.status} progress={item.progress} />
        </View>
      </View>
    </View>
  );
}

// ---------- Movies / Shows / a genre on a service

export function SectionScreen({provider, title, type, cat}: {provider: Provider; title: string; type: string; cat?: string}) {
  const store = useStore();
  const theme = serviceTheme(provider.name);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const q: Record<string, string> = {type};
    if (cat) q.cat = cat;
    try {
      setPage(await api.get<RowsPage>(`/browse/provider/${provider.id}/rows`, q));
    } catch (e) {
      setError(errorText(e));
    }
  }, [provider.id, type, cat]);

  useEffect(() => {
    load();
  }, [load]);

  const query: Record<string, string> = {type, sort: 'popular'};
  if (cat) query.cat = cat;
  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingVertical: 40}}>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: M.gutter, marginBottom: 20}}>
          <Picture uri={provider.logo} style={{width: 56, height: 56, borderRadius: 10}} />
          <Text style={{color: '#FFFFFF', fontSize: 48, fontWeight: '800'}}>{upper(theme, title)}</Text>
          <Text style={{color: C.dim, fontSize: 30}}>on {provider.name}</Text>
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
                preferredFirst={!page.hero && i === 0}
                more={(n) => moreRows(provider, row, n, type, cat)}
              />
            ))}
            <View style={{paddingHorizontal: M.gutter, flexDirection: 'row'}}>
              <Button title="See everything" icon="▦" onPress={() => store.push({name: 'browse', provider, title, query})} theme={theme} />
            </View>
          </>
        ) : (
          <Loading height={500} />
        )}
      </ScrollView>
    </Background>
  );
}

// ---------- a grid that keeps loading

function ItemGridList({items, theme, header, onEnd, footer}: {
  items: Item[];
  theme: ServiceTheme;
  header?: React.ReactElement;
  onEnd?: () => void;
  footer?: React.ReactElement | null;
}) {
  const store = useStore();
  const size = tileSize(theme);
  const gap = M.spacing / 2;
  const columns = Math.max(1, Math.floor((1920 - 2 * M.gutter + gap) / (size.width + gap)));
  return (
    <FlatList
      key={columns}
      data={items}
      numColumns={columns}
      keyExtractor={itemKey}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      columnWrapperStyle={columns > 1 ? {gap: gap - 8} : undefined}
      contentContainerStyle={{paddingHorizontal: M.gutter - 8, paddingBottom: 60}}
      ItemSeparatorComponent={() => <View style={{height: gap}} />}
      onEndReached={onEnd}
      onEndReachedThreshold={1.5}
      renderItem={({item, index}) => (
        <ItemCard item={item} theme={theme} preferred={index === 0} onPress={() => store.push({name: 'item', item, theme})} />
      )}
    />
  );
}

export function BrowseGridScreen({provider, title, query}: {provider: Provider; title: string; query: Record<string, string>}) {
  const theme = serviceTheme(provider.name);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const st = useRef({page: 0, total: 1, loading: false});

  const next = useCallback(async () => {
    const s = st.current;
    if (s.loading || s.page >= s.total) return;
    s.loading = true;
    setLoading(true);
    try {
      let added = 0;
      // a page that's all repeats: go straight on to the next so the grid doesn't stall
      while (added === 0 && s.page < s.total) {
        const d = await api.get<DiscoverPage>(`/browse/provider/${provider.id}`, {...query, page: String(s.page + 1), quick: 'true'});
        s.page = d.page;
        s.total = d.total_pages;
        setItems((cur) => {
          const seen = new Set(cur.map(itemKey));
          const fresh = d.results.filter((it) => !seen.has(itemKey(it)));
          added = fresh.length;
          return fresh.length ? [...cur, ...fresh] : cur;
        });
        if (d.results.length === 0) break;
      }
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
    s.loading = false;
    setLoading(false);
  }, [provider.id, query]);

  useEffect(() => {
    next();
  }, [next]);

  return (
    <Background theme={theme}>
      <ItemGridList
        items={items}
        theme={theme}
        onEnd={next}
        header={
          <Text style={{color: '#FFFFFF', fontSize: 48, fontWeight: '800', marginVertical: 40, marginHorizontal: 8}}>
            {upper(theme, title)} on {provider.name}
          </Text>
        }
        footer={
          error ? (
            <ErrorView message={error} retry={next} theme={theme} />
          ) : loading ? (
            <Loading height={160} />
          ) : items.length === 0 ? (
            <Text style={{color: C.dim, fontSize: 28, textAlign: 'center', padding: 40}}>Nothing here right now.</Text>
          ) : null
        }
      />
    </Background>
  );
}

// ---------- search

export function SearchScreen({provider}: {provider?: Provider}) {
  const store = useStore();
  const theme = provider ? serviceTheme(provider.name) : store.theme;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const path = provider ? `/browse/provider/${provider.id}/search` : '/search';
        const r = await api.get<{results: Item[]}>(path, {q});
        if (alive) setResults(r.results);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
      if (alive) setSearching(false);
    }, 450); // wait for the typing to pause
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, provider]);

  return (
    <Background theme={theme}>
      <ItemGridList
        items={results}
        theme={theme}
        header={
          <View style={{marginVertical: 40, marginHorizontal: 8, gap: 16}}>
            <Text style={{color: '#FFFFFF', fontSize: 44, fontWeight: '800'}}>{provider ? `Search ${provider.name}` : 'Search'}</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={provider ? `Search ${provider.name}` : 'Search movies and shows'}
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCorrect={false}
              hasTVPreferredFocus
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                fontSize: 32,
                color: '#FFFFFF',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 14,
                paddingHorizontal: 24,
                paddingVertical: 18,
                borderWidth: 4,
                borderColor: focused ? '#FFFFFF' : 'transparent',
                maxWidth: 1000,
              }}
            />
            {error ? <Text style={{color: C.red, fontSize: 26}}>{error}</Text> : null}
            {searching ? <Loading height={80} /> : null}
            {!searching && !error && results.length === 0 && query.trim().length >= 2 ? (
              <Text style={{color: C.dim, fontSize: 26}}>Nothing found.</Text>
            ) : null}
          </View>
        }
      />
    </Background>
  );
}

// ---------- settings

export function SettingsScreen() {
  const store = useStore();
  const theme = store.theme;
  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{padding: M.gutter, gap: 30}}>
        <Text style={{color: '#FFFFFF', fontSize: 56, fontWeight: '800'}}>Settings</Text>
        <View style={{gap: 6}}>
          <Text style={{color: C.dim, fontSize: 24}}>Signed in as</Text>
          <Text style={{color: '#FFFFFF', fontSize: 32}}>{store.me?.name ?? '…'}</Text>
          <Text style={{color: C.dim, fontSize: 24, marginTop: 10}}>Server</Text>
          <Text style={{color: '#FFFFFF', fontSize: 28, fontFamily: 'monospace'}}>{store.server}</Text>
        </View>
        <View style={{gap: 14}}>
          <Text style={{color: '#FFFFFF', fontSize: 34, fontWeight: '700'}}>Theme</Text>
          <Text style={{color: C.dim, fontSize: 22}}>
            For NuniFlix's own screens. Browsing a service keeps that service's look. Same theme as on the website.
          </Text>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 16}}>
            {APP_THEMES.map((t, i) => (
              <Button
                key={t.id}
                title={(store.themeId === t.id ? '✓ ' : '') + t.name}
                onPress={() => store.setTheme(t.id)}
                theme={theme}
                primary={store.themeId === t.id}
                preferred={i === 0}
              />
            ))}
          </View>
        </View>
        <View style={{flexDirection: 'row', gap: 20, marginTop: 20}}>
          <Button title="Sign out" onPress={() => store.signOut()} theme={theme} />
          <Button title="Use a different server" onPress={() => store.clearServer()} theme={theme} />
        </View>
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: M.serviceTile.width,
    height: M.serviceTile.height,
    borderRadius: 14,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingHorizontal: 20,
  },
});
