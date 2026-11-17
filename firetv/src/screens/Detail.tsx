// A title: backdrop, what it is, whether it's on the server, Request / Play. Mirrors apple/Sources/Views/DetailView.swift.
// Play here: the movie or an episode, from the person's own Plex/Jellyfin, in the app's player (Player.tsx).
import React, {useCallback, useEffect, useState} from 'react';
import {BackHandler, Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import {api, ApiError, errorText} from '../api';
import {can4K, canRequest, canResume, clock, episodeCode, Extras, Item, itemKey, PlayItem, PlayOptions, Season, seasonComplete} from '../models';
import {useStore} from '../store';
import {M, ServiceTheme, upper} from '../theme';
import {Background, Button, C, Focusable, Heading, ItemRow, Loading, Notice, Picture, StatusBadge} from '../components/ui';

export function DetailScreen({item: start, theme}: {item: Item; theme: ServiceTheme}) {
  const store = useStore();
  const [item, setItem] = useState<Item>(start);
  const [extras, setExtras] = useState<Extras | null>(null);
  const [links, setLinks] = useState<{plex?: string | null; jellyfin?: string | null}>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pickSeasons, setPickSeasons] = useState<null | {is4k: boolean}>(null);
  const [options, setOptions] = useState<PlayOptions | null>(null);
  const [episodes, setEpisodes] = useState(false); // the episode list is open
  const [resumeChoice, setResumeChoice] = useState<PlayItem | null>(null);

  const load = useCallback(async () => {
    let full = start;
    try {
      let path: string;
      if (start.type === 'movie' && (start.id ?? start.tmdb)) path = `/item/movie/${start.id ?? start.tmdb}`;
      else if (start.id) path = `/item/tv/${start.id}`;
      else if (start.tmdb) path = `/item/tvtmdb/${start.tmdb}`;
      else throw new ApiError(0, "Can't look this one up.");
      const got = await api.get<Item>(path);
      // keep the catalog's pictures if the server's copy has none
      full = {...got, backdrop: got.backdrop ?? start.backdrop, poster: got.poster ?? start.poster, overview: got.overview ?? start.overview};
      setItem(full);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
    setLoaded(true);
    if ((full.status === 'available' || full.status === 'partial') && full.id) {
      api.get<typeof links>(`/watch/${full.type}/${full.id}`).then(setLinks, () => {});
    }
    if (full.tmdb) api.get<Extras>(`/extra/${full.type}/${full.tmdb}`).then(setExtras, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey(start)]);

  useEffect(() => {
    load();
  }, [load]);

  // Back closes the season picker / message first, before leaving the page.
  useEffect(() => {
    if (!pickSeasons && !message && !episodes && !resumeChoice) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (resumeChoice) setResumeChoice(null);
      else if (message) setMessage(null);
      else {
        setPickSeasons(null);
        setEpisodes(false);
      }
      return true;
    });
    return () => sub.remove();
  }, [pickSeasons, message, episodes, resumeChoice]);

  /** Play here. A movie starts (or offers to resume); a show opens its episodes. */
  async function play() {
    if (item.id == null) return;
    setBusy(true);
    try {
      const o = options ?? (await api.get<PlayOptions>(`/play/${item.type}/${item.id}`));
      setOptions(o);
      if (item.type === 'tv') setEpisodes(true);
      else if (o.items[0]) choose(o.items[0]);
    } catch (e) {
      setMessage(errorText(e));
    }
    setBusy(false);
  }

  function choose(e: PlayItem) {
    if (canResume(e)) setResumeChoice(e);
    else begin(e, 0);
  }

  function begin(e: PlayItem, at: number) {
    const all = options?.items ?? [e];
    const i = all.findIndex((x) => x.id === e.id);
    setResumeChoice(null);
    setEpisodes(false);
    setOptions(null); // resume points change while watching: ask again next time
    store.push({name: 'player', title: item.title ?? '', queue: i >= 0 ? all.slice(i) : [e], at});
  }

  const isMovie = item.type === 'movie';
  const may = (is4k: boolean) => {
    const me = store.me;
    if (!me || item.id == null || !canRequest(me, item.type)) return false;
    if (is4k) return can4K(me, item.type) && item.status4k !== 'available' && item.status4k !== 'processing';
    if (!item.status || item.status === 'none') return true;
    return item.status === 'partial' && !isMovie;
  };

  async function request(is4k: boolean, seasons: number[] | null) {
    if (item.id == null) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {type: item.type, id: item.id, is4k};
      if (seasons) body.seasons = seasons;
      const [text] = await api.post('/requests', body);
      const status = JSON.parse(text)?.request?.status;
      setMessage(status === 'approved' ? "Approved. It's on its way." : "Requested. You'll get a notification when it's approved and again when it's ready.");
      await load();
    } catch (e) {
      setMessage(errorText(e));
    }
    setBusy(false);
  }

  function startRequest(is4k: boolean) {
    if (isMovie || (item.seasons ?? []).length <= 1) request(is4k, null);
    else setPickSeasons({is4k});
  }

  async function openPlex(web: string) {
    // https://app.plex.tv/desktop/#!/server/<machine>/details?key=%2Flibrary%2Fmetadata%2F123 -> plex://preplay/?...
    const s = web.indexOf('/server/');
    const d = web.indexOf('/details?key=', s);
    if (s >= 0 && d > s) {
      const machine = web.slice(s + 8, d);
      const key = web.slice(d + 13);
      try {
        await Linking.openURL(`plex://preplay/?metadataKey=${key}&server=${machine}`);
        return;
      } catch {}
    }
    setMessage(`Open the Plex app to watch ${item.title ?? 'it'}.`);
  }

  const facts = [
    item.year && String(item.year),
    item.certification || null,
    item.runtime ? (isMovie ? `${Math.floor(item.runtime / 60)}h ${item.runtime % 60}m` : `${item.runtime}m episodes`) : null,
    item.network || null,
    item.rating ? `★ ${item.rating.toFixed(1)}` : null,
    ...(item.genres ?? []),
  ]
    .filter(Boolean)
    .join('  ·  ');

  const onServer = item.status === 'available' || item.status === 'partial';
  const buttons: React.ReactNode[] = [];
  if (loaded) {
    if (onServer && item.id != null)
      buttons.push(<Button key="play" title={isMovie ? 'Play' : 'Episodes'} icon="▶" onPress={play} theme={theme} primary disabled={busy} />);
    if (onServer && links.plex) buttons.push(<Button key="plex" title="Open in Plex" onPress={() => openPlex(links.plex!)} theme={theme} />);
    if (may(false))
      buttons.push(<Button key="req" title={item.status === 'partial' ? 'Request more' : 'Request'} icon="+" onPress={() => startRequest(false)} theme={theme} primary disabled={busy} />);
    if (may(true)) buttons.push(<Button key="4k" title="Request in 4K" icon="4K" onPress={() => startRequest(true)} theme={theme} disabled={busy} />);
  }

  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{paddingBottom: M.spacing * 2}}>
        <View style={{height: M.heroHeight + 120, justifyContent: 'flex-end'}}>
          <Picture uri={item.backdrop ?? item.poster} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, {backgroundColor: theme.background[0], opacity: 0.3}]} />
          <View style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: '65%', backgroundColor: theme.background[0], opacity: 0.8}} />
          <View style={{paddingHorizontal: M.gutter, paddingBottom: 20, gap: 14, maxWidth: 1300}}>
            {extras?.logo ? (
              <Picture uri={extras.logo} style={{width: 560, height: 160}} fit />
            ) : (
              <Text style={{color: '#FFFFFF', fontSize: 64, fontWeight: '900'}}>{upper(theme, item.title ?? '')}</Text>
            )}
            <Text style={{color: 'rgba(255,255,255,0.8)', fontSize: 24, fontWeight: '600'}}>{facts}</Text>
            {item.overview ? (
              <Text style={{color: 'rgba(255,255,255,0.9)', fontSize: 25}} numberOfLines={5}>
                {item.overview}
              </Text>
            ) : null}
            {item.streaming?.length ? (
              <Text style={{color: 'rgba(255,255,255,0.7)', fontSize: 20}}>Streaming on {item.streaming.map((p) => p.name).join(', ')}</Text>
            ) : null}
            <View style={{flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 20, marginTop: 8}}>
              {!loaded ? <Loading height={70} /> : null}
              {buttons.map((b, i) => (i === 0 ? React.cloneElement(b as React.ReactElement<{preferred?: boolean}>, {preferred: !pickSeasons && !message}) : b))}
              {loaded && buttons.length === 0 ? (
                // nothing to press: something focusable so the remote isn't lost
                <Focusable preferred corner={20}>
                  <Text style={{color: C.dim, fontSize: 24, padding: 12}}>{onServer ? 'On the server' : 'Not on the server yet'}</Text>
                </Focusable>
              ) : null}
              <StatusBadge status={item.status} progress={item.progress} />
              {item.requested_by && item.status !== 'available' ? (
                <Text style={{color: 'rgba(255,255,255,0.7)', fontSize: 20}}>asked for by {item.requested_by}</Text>
              ) : null}
            </View>
            {error ? <Text style={{color: C.orange, fontSize: 24}}>{error}</Text> : null}
          </View>
        </View>

        {item.seasons?.length ? <SeasonStrip seasons={item.seasons} theme={theme} /> : null}
        {extras?.cast?.length ? <CastRow cast={extras.cast} theme={theme} /> : null}
        {extras?.collection && extras.collection.items.length > 1 ? (
          <ItemRow title={extras.collection.name ?? 'The collection'} theme={theme} items={extras.collection.items} />
        ) : null}
        {extras?.recommendations?.length ? <ItemRow title="More like this" theme={theme} items={extras.recommendations} /> : null}
      </ScrollView>

      {pickSeasons ? (
        <SeasonPicker
          item={item}
          is4k={pickSeasons.is4k}
          theme={theme}
          onCancel={() => setPickSeasons(null)}
          onDone={(seasons) => {
            const k = pickSeasons.is4k;
            setPickSeasons(null);
            request(k, seasons);
          }}
        />
      ) : null}
      {episodes && options ? (
        <EpisodePicker title={item.title ?? 'Episodes'} episodes={options.items} theme={theme} onPick={choose} />
      ) : null}
      {resumeChoice ? (
        <View style={[StyleSheet.absoluteFill, {backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center'}]}>
          <View style={{backgroundColor: '#1C1C1E', borderRadius: 24, padding: 50, alignItems: 'center', gap: 30}}>
            <Text style={{color: '#FFFFFF', fontSize: 34, fontWeight: '800'}}>
              {[episodeCode(resumeChoice), resumeChoice.title || item.title].filter(Boolean).join('  ·  ')}
            </Text>
            <View style={{flexDirection: 'row', gap: 24}}>
              <Button title={`Resume from ${clock(resumeChoice.resume)}`} icon="▶" onPress={() => begin(resumeChoice, resumeChoice.resume)} theme={theme} primary preferred />
              <Button title="Start over" onPress={() => begin(resumeChoice, 0)} theme={theme} />
            </View>
          </View>
        </View>
      ) : null}
      {message ? <Notice message={message} onClose={() => setMessage(null)} theme={theme} /> : null}
    </Background>
  );
}

function seasonLine(s: Season): string {
  if (seasonComplete(s)) return 'On server';
  if ((s.have ?? 0) > 0) return `${s.have} of ${s.episodes ?? 0}`;
  if (s.monitored) return 'On its way';
  return `${s.episodes ?? 0} episodes`;
}

function SeasonStrip({seasons, theme}: {seasons: Season[]; theme: ServiceTheme}) {
  return (
    <View style={{paddingHorizontal: M.gutter, marginVertical: M.spacing / 2}}>
      <Heading theme={theme} style={{marginBottom: 12}}>
        Seasons
      </Heading>
      <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 14}}>
        {seasons.map((s) => (
          <View key={s.n} style={{backgroundColor: C.faint, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center'}}>
            <Text style={{color: '#FFFFFF', fontSize: 22, fontWeight: '600'}}>Season {s.n}</Text>
            <Text style={{color: seasonComplete(s) ? C.green : C.dim, fontSize: 18}}>{seasonLine(s)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function CastRow({cast, theme}: {cast: Extras['cast']; theme: ServiceTheme}) {
  return (
    <View style={{marginVertical: M.spacing / 2}}>
      <Heading theme={theme} style={{marginHorizontal: M.gutter, marginBottom: 12}}>
        Cast
      </Heading>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{paddingHorizontal: M.gutter - 8, gap: 12}}>
        {cast.map((c) => (
          <Focusable key={c.id} corner={75}>
            <View style={{width: 180, alignItems: 'center', gap: 6, paddingVertical: 6}}>
              <Picture uri={c.photo} label={c.name.slice(0, 1)} style={{width: 150, height: 150, borderRadius: 75}} />
              <Text style={{color: '#FFFFFF', fontSize: 20, fontWeight: '600'}} numberOfLines={1}>
                {c.name}
              </Text>
              {c.role ? (
                <Text style={{color: C.dim, fontSize: 17}} numberOfLines={1}>
                  {c.role}
                </Text>
              ) : null}
            </View>
          </Focusable>
        ))}
      </ScrollView>
    </View>
  );
}

/** Which seasons? Ones already complete on the server are left out. Nothing is picked for you. */
function SeasonPicker({item, is4k, theme, onDone, onCancel}: {
  item: Item;
  is4k: boolean;
  theme: ServiceTheme;
  onDone: (seasons: number[] | null) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const choices = (item.seasons ?? []).filter((s) => is4k || !seasonComplete(s));
  const toggle = (n: number) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const list = [...picked].sort((a, b) => a - b);
  return (
    <View style={[StyleSheet.absoluteFill, {backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center'}]}>
      <View style={{backgroundColor: '#1C1C1E', borderRadius: 24, padding: 50, width: 1100, maxHeight: 960}}>
        <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '800', marginBottom: 6}}>{is4k ? 'Request in 4K' : `Request ${item.title ?? ''}`}</Text>
        <Text style={{color: C.dim, fontSize: 24, marginBottom: 20}}>Pick the seasons you want</Text>
        <ScrollView style={{maxHeight: 560}} contentContainerStyle={{gap: 10, padding: 6}}>
          {choices.map((s, i) => (
            <Focusable key={s.n} onPress={() => toggle(s.n)} corner={12} scale={1.02} preferred={i === 0}>
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 20, backgroundColor: C.faint, borderRadius: 12, padding: 18}}>
                <Text style={{color: picked.has(s.n) ? theme.accent === '#FFFFFF' ? C.green : theme.accent : C.dim, fontSize: 30}}>
                  {picked.has(s.n) ? '●' : '○'}
                </Text>
                <Text style={{color: '#FFFFFF', fontSize: 28, flex: 1}}>Season {s.n}</Text>
                <Text style={{color: C.dim, fontSize: 22}}>
                  {(s.have ?? 0) > 0 ? `${s.have} of ${s.episodes ?? 0} on server` : `${s.episodes ?? 0} episodes`}
                </Text>
              </View>
            </Focusable>
          ))}
        </ScrollView>
        <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 20, marginTop: 30}}>
          <Button
            title={list.length === 0 ? 'Pick at least one season' : `Request ${list.length === 1 ? `Season ${list[0]}` : `${list.length} seasons`}`}
            onPress={() => onDone(list)}
            theme={theme}
            primary
            disabled={list.length === 0}
          />
          <Button title="Cancel" onPress={onCancel} theme={theme} />
          {/* last on purpose: the whole show is never the first thing focused */}
          <Button title="Every season (the whole show)" onPress={() => onDone(null)} theme={theme} />
        </View>
      </View>
    </View>
  );
}

/** A show's episodes, season by season, with "Next up" first: the one being watched, or the first not watched yet. */
function EpisodePicker({title, episodes, theme, onPick}: {
  title: string;
  episodes: PlayItem[];
  theme: ServiceTheme;
  onPick: (e: PlayItem) => void;
}) {
  const nextUp = episodes.find(canResume) ?? episodes.find((e) => !e.watched) ?? episodes[0];
  const seasons = [...new Set(episodes.map((e) => e.season ?? 0))].sort((a, b) => a - b);
  const row = (e: PlayItem, preferred: boolean, key: string) => (
    <Focusable key={key} onPress={() => onPick(e)} corner={12} scale={1.02} preferred={preferred}>
      <View style={{flexDirection: 'row', alignItems: 'center', gap: 20, backgroundColor: C.faint, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 16}}>
        <Text style={{color: e.watched ? C.green : C.dim, fontSize: 28, width: 34}}>{e.watched ? '✓' : canResume(e) ? '▶' : '○'}</Text>
        <View style={{flex: 1}}>
          <Text style={{color: '#FFFFFF', fontSize: 27, fontWeight: '600'}} numberOfLines={1}>
            {e.title || `Episode ${e.episode ?? ''}`}
          </Text>
          <Text style={{color: C.dim, fontSize: 20}}>
            {[episodeCode(e), e.duration > 0 ? `${Math.round(e.duration / 60)}m` : null, canResume(e) ? `${Math.round((e.duration - e.resume) / 60)}m left` : null]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </View>
      </View>
    </Focusable>
  );
  return (
    <View style={[StyleSheet.absoluteFill, {backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center'}]}>
      <View style={{backgroundColor: '#1C1C1E', borderRadius: 24, paddingVertical: 40, paddingHorizontal: 50, width: 1200, height: 960}}>
        <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '800', marginBottom: 16}}>{title}</Text>
        <ScrollView contentContainerStyle={{gap: 10, padding: 8, paddingBottom: 40}}>
          {nextUp ? (
            <>
              <Heading theme={theme} style={{fontSize: 26, marginTop: 4}}>
                Next up
              </Heading>
              {row(nextUp, true, 'next')}
            </>
          ) : null}
          {seasons.map((n) => (
            <View key={n} style={{gap: 10}}>
              <Heading theme={theme} style={{fontSize: 26, marginTop: 18}}>
                {n === 0 ? 'Specials' : `Season ${n}`}
              </Heading>
              {episodes.filter((e) => (e.season ?? 0) === n).map((e) => row(e, false, e.id))}
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}
