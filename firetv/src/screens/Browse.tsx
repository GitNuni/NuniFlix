// Home (pick a service), YourFlix, a service's home, its sections and full grids, search, settings.
// Mirrors apple/Sources/Views/BrowseViews.swift.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FlatList, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {api, errorText} from '../api';
import {DiscoverPage, Extras, GenreRef, Item, itemKey, Provider, Row, RowsPage} from '../models';
import {useStore} from '../store';
import {APP_THEMES, M, ServiceTheme, serviceTheme, tileSize, upper} from '../theme';
import {Background, Button, C, ErrorView, Focusable, Heading, ItemCard, ItemRow, Loading, Picture, StatusBadge} from '../components/ui';

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

/** Everything on a service (or, with no provider, on your own Plex/Jellyfin), a page at a time. */
export function BrowseGridScreen({provider, title, query}: {provider?: Provider; title: string; query: Record<string, string>}) {
  const store = useStore();
  const theme: ServiceTheme = provider ? serviceTheme(provider.name) : {...store.theme, tile: 'poster'};
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const st = useRef({page: 0, total: 1, loading: false, seen: new Set<string>()});
  const endpoint = provider ? `/browse/provider/${provider.id}` : '/library';

  const next = useCallback(async () => {
    const s = st.current;
    if (s.loading || s.page >= s.total) return;
    s.loading = true;
    setLoading(true);
    try {
      let added = 0;
      // a page that's all repeats: go straight on to the next so the grid doesn't stall
      while (added === 0 && s.page < s.total) {
        const q: Record<string, string> = {...query, page: String(s.page + 1)};
        if (provider) q.quick = 'true';
        const d = await api.get<DiscoverPage>(endpoint, q);
        s.page = d.page;
        s.total = d.total_pages;
        const fresh = d.results.filter((it) => !s.seen.has(itemKey(it)));
        fresh.forEach((it) => s.seen.add(itemKey(it)));
        added = fresh.length;
        if (fresh.length) setItems((cur) => [...cur, ...fresh]);
        if (d.results.length === 0) break;
      }
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
    s.loading = false;
    setLoading(false);
  }, [endpoint, provider, query]);

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
            {upper(theme, title)} on {provider?.name ?? 'your library'}
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
          <Text style={{color: '#FFFFFF', fontSize: 28, fontFamily: 'monospace'}}>{store.demo ? 'The demo (no server)' : store.server}</Text>
          {store.demo ? <Text style={{color: C.dim, fontSize: 20}}>Demo films: Blender Foundation open movies (CC BY), blender.org</Text> : null}
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
        <View style={{gap: 14}}>
          <Text style={{color: '#FFFFFF', fontSize: 34, fontWeight: '700'}}>Live TV hosts</Text>
          <Text style={{color: C.dim, fontSize: 22}}>
            Vesper introduces the shows on Live TV, and her sister Lucy drops in now and then. Same setting as on the website.
          </Text>
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 16}}>
            {[
              ['both', 'Vesper and Lucy'],
              ['vesper', 'Just Vesper'],
              ['off', 'No hosts'],
            ].map(([k, label]) => {
              const on = (store.me?.prefs?.hosts ?? 'both') === k;
              return <Button key={k} title={(on ? '✓ ' : '') + label} onPress={() => store.setPref('hosts', k)} theme={theme} primary={on} />;
            })}
          </View>
        </View>
        <View style={{flexDirection: 'row', gap: 20, marginTop: 20}}>
          {store.profiles.length > 1 ? <Button title="Switch profile" onPress={() => store.setChoosingProfile(true)} theme={theme} /> : null}
          {store.demo ? (
            <Button title="Leave the demo" onPress={() => store.clearServer()} theme={theme} primary />
          ) : (
            <>
              <Button title="Sign out" onPress={() => store.signOut()} theme={theme} />
              <Button title="Use a different server" onPress={() => store.clearServer()} theme={theme} />
            </>
          )}
        </View>
      </ScrollView>
    </Background>
  );
}


