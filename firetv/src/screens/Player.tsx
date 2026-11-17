// Watching in the app, full screen. Like apple/Sources/Views/PlayerView.swift: the server finds the title on the
// person's own Plex/Jellyfin and passes the stream through (server/app/player.py); progress goes back every
// 10 seconds so Plex/Jellyfin keep the resume point and history; at the end it moves on to the next episode.
// With `live`, it's a Live TV channel instead (server/app/channels.py): it joins whatever's on part-way through.
//
// Remote: Play/Pause or Select pauses; Left/Right skip 10 s (press again to go further); Rewind/Fast-forward skip
// 30 s; Up/Down show where you are (on Live TV they change channel); Back leaves.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, StyleSheet, Text, View} from 'react-native';
import {useTVEventHandler} from '@amazon-devices/react-native-kepler';
import {KeplerVideoSurfaceView, VideoPlayer} from '@amazon-devices/react-native-w3cmedia';
import {api, errorText, serverURL} from '../api';
import {clock, episodeCode, HostSays, hm, LiveChannel, LiveProgram, LiveTune, liveTZ, PlayItem, programLabel, StreamStart} from '../models';
import {useStore} from '../store';
import {Hls} from '../player/hls';
import {log} from '../log';
import {Button, C, Picture} from '../components/ui';
import {G, HostCard} from './Live';

const PLATFORM = 'firetv';

/** What shows over the picture for a few seconds after tuning in, or full screen (the ident) until a show starts. */
interface Bug {
  channel?: LiveChannel;
  name: string;
  tagline: string;
  now: LiveProgram;
  next?: LiveProgram;
  host?: HostSays;
  startsAt?: number; // unix seconds: the ident, counting down
}

export function PlayerScreen({title, queue, at, live}: {
  title: string;
  queue: PlayItem[];
  at: number;
  live?: {key: string; channels: LiveChannel[]};
}) {
  const store = useStore();
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState(at);
  const [duration, setDuration] = useState(queue[0]?.duration ?? 0);
  const [paused, setPaused] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState(true);
  const [pending, setPending] = useState<number | null>(null); // where a run of skips will land
  const [heading, setHeading] = useState(title);
  const [subheading, setSubheading] = useState('');
  const [bug, setBug] = useState<Bug | null>(null);
  const [, setTick] = useState(0); // re-renders twice a second: the clock, the ident's countdown

  const player = useRef<VideoPlayer | null>(null);
  const surface = useRef<string | null>(null);
  const engine = useRef<Hls | null>(null);
  const session = useRef<string | null>(null);
  const holdAt = useRef<number | null>(null); // until playback reaches the resume point, report that instead of 0:00
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<number | null>(null);
  const closed = useRef(false);
  const channel = useRef(live?.key ?? '');
  const tuneSeq = useRef(0);
  const current = queue[index];

  const now = () => player.current?.currentTime ?? 0;

  const poke = useCallback((stay?: boolean) => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!stay) hideTimer.current = setTimeout(() => setControls(false), 4000);
  }, []);

  const report = useCallback(
    (state: 'playing' | 'paused' | 'stopped') => {
      const sid = session.current;
      if (!sid) return Promise.resolve();
      if (state === 'stopped') session.current = null;
      const pos = holdAt.current ?? now();
      return api.post('/play/progress', {session: sid, position: pos, duration: engine.current?.duration || duration, state}).then(
        () => {},
        () => {},
      );
    },
    [duration],
  );

  const stopStream = useCallback(async () => {
    engine.current?.destroy();
    engine.current = null;
    await report('stopped');
  }, [report]);

  /** Plays a started stream from `from` seconds. */
  const attach = useCallback(async (s: StreamStart, from: number, isCurrent: () => boolean) => {
    const vp = player.current;
    if (!vp) return;
    session.current = s.session;
    const hls = new Hls(vp, serverURL(s.url));
    hls.onLog = (m) => log('hls', m);
    hls.onError = (m) => isCurrent() && setError(m);
    engine.current = hls;
    await hls.start(from);
    if (closed.current || engine.current !== hls || !isCurrent()) return;
    if (hls.duration) setDuration(hls.duration);
    await vp.play();
  }, []);

  /** Starts one movie/episode at `from` seconds. */
  const begin = useCallback(
    async (item: PlayItem, from: number) => {
      setWaiting(true);
      setError(null);
      setPosition(from);
      setDuration(item.duration);
      setSubheading([episodeCode(item), item.title && item.title !== title ? item.title : null].filter(Boolean).join('  ·  '));
      holdAt.current = from > 0 ? from : null;
      try {
        const [text] = await api.post('/play/start', {id: item.id, offset: 0, at: from, platform: PLATFORM});
        const s = JSON.parse(text) as StreamStart;
        if (closed.current) {
          api.post('/play/progress', {session: s.session, position: from, state: 'stopped'}).catch(() => {});
          return;
        }
        await attach(s, from, () => true);
      } catch (e) {
        log('start failed', errorText(e));
        if (!closed.current) setError(errorText(e) ?? 'The video wouldn’t start.');
      }
    },
    [attach, title],
  );

  /** Live: join a channel part-way through whatever it's showing (or wait out the ident if a show is about to start). */
  const tune = useCallback(
    async (key: string) => {
      const me = ++tuneSeq.current;
      const isCurrent = () => me === tuneSeq.current && !closed.current;
      channel.current = key;
      const ch = live?.channels.find((c) => c.key === key);
      setError(null);
      setWaiting(true);
      setBug(null);
      setHeading(ch ? `${ch.number}  ${ch.name}` : title);
      setSubheading('');
      try {
        player.current?.pause();
      } catch {}
      stopStream(); // don't wait for it
      const asked = Date.now();
      let t: LiveTune;
      try {
        t = await api.get<LiveTune>(`/live/${key}`, {tz: liveTZ(), platform: PLATFORM});
      } catch (e) {
        if (isCurrent()) setError(errorText(e));
        return;
      }
      if (!isCurrent()) {
        // flipped again meanwhile
        if (t.stream) api.post('/play/progress', {session: t.stream.session, position: 0, state: 'stopped'}).catch(() => {});
        return;
      }
      const p = t.program;
      const name = t.channel?.name ?? ch?.name ?? '';
      setHeading(`${ch?.number ?? ''}  ${name}`.trim());
      setSubheading(programLabel(p));
      setDuration(p.end - p.start);
      const card: Bug = {channel: ch, name, tagline: t.channel?.tagline ?? ch?.tagline ?? '', now: p, next: t.next, host: t.host};
      let stream = t.stream;
      if (t.offset < 0) {
        // between programmes: the channel's ident and a countdown, then it starts
        setWaiting(false);
        setBug({...card, startsAt: Date.now() / 1000 - t.offset});
        await new Promise<void>((r) => setTimeout(() => r(), -t.offset * 1000));
        if (!isCurrent()) return;
        if (stream) api.post('/play/progress', {session: stream.session, position: 0, state: 'stopped'}).catch(() => {});
        stream = undefined;
        setWaiting(true);
      }
      setBug(card);
      if (bugTimer.current) clearTimeout(bugTimer.current);
      bugTimer.current = setTimeout(() => setBug((b) => (b === card ? null : b)), 9000);
      const from = Math.max(0, t.offset + (stream ? 0 : (Date.now() - asked) / 1000));
      try {
        if (!stream) {
          const [text] = await api.post('/play/start', {id: p.id, offset: 0, at: from, platform: PLATFORM, live: true});
          stream = JSON.parse(text) as StreamStart;
          if (!isCurrent()) {
            api.post('/play/progress', {session: stream.session, position: 0, state: 'stopped'}).catch(() => {});
            return;
          }
        }
        await attach(stream, from, isCurrent);
      } catch (e) {
        log('tune failed', errorText(e));
        if (isCurrent()) setError(errorText(e) ?? 'That channel wouldn’t come in.');
      }
    },
    [attach, live, stopStream, title],
  );

  const flip = useCallback(
    (step: number) => {
      const chs = live?.channels ?? [];
      if (!chs.length) return;
      const i = chs.findIndex((c) => c.key === channel.current);
      const next = chs[(i + step + chs.length) % chs.length];
      tune(next.key);
    },
    [live, tune],
  );

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    try {
      player.current?.pause();
    } catch {}
    stopStream();
    store.pop();
  }, [stopStream, store]);

  // the player: created once, given the screen surface when it's there
  useEffect(() => {
    const vp = new VideoPlayer();
    let alive = true;
    vp.initialize().then(() => {
      if (!alive) return;
      player.current = vp;
      vp.autoplay = false;
      if (surface.current) vp.setSurfaceHandle(surface.current);
      vp.addEventListener('waiting', () => setWaiting(true));
      vp.addEventListener('playing', () => {
        setWaiting(false);
        setPaused(false);
      });
      vp.addEventListener('canplay', () => setWaiting(false));
      vp.addEventListener('pause', () => setPaused(true));
      vp.addEventListener('play', () => setPaused(false));
      vp.addEventListener('error', () => {
        log('video error', (vp as any).error?.message ?? '');
        setError('The video wouldn’t play.');
      });
      vp.addEventListener('ended', () => {
        if (live) tune(channel.current); // whatever the channel shows next
        else setIndex((i) => i + 1);
      });
      if (live) tune(live.key);
      else begin(queue[0], at);
    });
    return () => {
      alive = false;
      closed.current = true;
      engine.current?.destroy();
      if (session.current) report('stopped');
      try {
        vp.pause();
        vp.deinitialize();
      } catch {}
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the next episode when one ends, or close at the end of the queue
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    (async () => {
      await stopStream();
      if (index >= queue.length) close();
      else begin(queue[index], 0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // the clock on screen, and progress to the server every 10 s (live: a keep-alive)
  useEffect(() => {
    const t = setInterval(() => {
      const p = now();
      if (holdAt.current != null && Math.abs(p - holdAt.current) < 15 && p > 0) holdAt.current = null;
      setPosition(p);
      setTick((n) => n + 1);
    }, 500);
    const r = setInterval(() => {
      if (!waiting || paused) report(paused ? 'paused' : 'playing');
    }, 10000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [report, waiting, paused]);

  useEffect(() => {
    poke();
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pendingRef.current != null) {
        // cancel a skip that hasn't happened yet
        pendingRef.current = null;
        setPending(null);
        return true;
      }
      close();
      return true;
    });
    return () => {
      sub.remove();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (skipTimer.current) clearTimeout(skipTimer.current);
      if (bugTimer.current) clearTimeout(bugTimer.current);
    };
  }, [close, poke]);

  const togglePause = useCallback(() => {
    const vp = player.current;
    if (!vp) return;
    if (vp.paused) {
      vp.play();
      poke();
    } else {
      vp.pause();
      poke(true);
    }
    report(vp.paused ? 'paused' : 'playing');
  }, [poke, report]);

  /** Skips add up while the button keeps being pressed; the jump happens once the presses stop. */
  const skip = useCallback(
    (by: number) => {
      const total = engine.current?.duration || duration;
      const from = pendingRef.current ?? now();
      const to = Math.max(0, total ? Math.min(total - 2, from + by) : from + by);
      pendingRef.current = to;
      setPending(to);
      poke(true);
      if (skipTimer.current) clearTimeout(skipTimer.current);
      skipTimer.current = setTimeout(() => {
        const target = pendingRef.current;
        pendingRef.current = null;
        setPending(null);
        if (target == null) return;
        holdAt.current = null;
        engine.current?.seek(target);
        setPosition(target);
        poke();
      }, 700);
    },
    [duration, poke],
  );

  useTVEventHandler((evt) => {
    if (evt.eventKeyAction === 1 || error) return; // key-up
    switch (evt.eventType) {
      case 'playpause':
      case 'pause':
      case 'select':
        togglePause();
        break;
      case 'left':
        skip(-10);
        break;
      case 'right':
        skip(10);
        break;
      case 'rewind':
      case 'skip_backward':
        skip(-30);
        break;
      case 'forward':
      case 'fastforward':
      case 'skip_forward':
        skip(30);
        break;
      case 'up':
      case 'channel_up':
        if (live) flip(1);
        else poke();
        break;
      case 'down':
      case 'channel_down':
        if (live) flip(-1);
        else poke();
        break;
      case 'menu':
      case 'info':
        poke();
        break;
    }
  });

  const shown = pending ?? position;
  const total = engine.current?.duration || duration;
  const pct = total ? Math.min(100, (shown / total) * 100) : 0;
  const secondsNow = Date.now() / 1000;

  return (
    <View style={{flex: 1, backgroundColor: '#000000'}}>
      <KeplerVideoSurfaceView
        style={StyleSheet.absoluteFill}
        onSurfaceViewCreated={(h: string) => {
          surface.current = h;
          player.current?.setSurfaceHandle(h);
        }}
        onSurfaceViewDestroyed={(h: string) => {
          surface.current = null;
          player.current?.clearSurfaceHandle(h);
        }}
      />
      {waiting && !error && !bug?.startsAt ? (
        <View style={[StyleSheet.absoluteFill, {justifyContent: 'center', alignItems: 'center'}]}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          {live ? <Text style={[s.mono, {color: 'rgba(255,255,255,0.8)', fontSize: 28, marginTop: 20}]}>PLEASE STAND BY</Text> : null}
        </View>
      ) : null}
      {bug && !error ? (bug.startsAt ? <Ident bug={bug} now={secondsNow} /> : <BugCard bug={bug} />) : null}
      {(controls || paused || pending != null) && !error && !bug?.startsAt ? (
        <View style={s.bar}>
          <Text style={s.title} numberOfLines={1}>
            {heading}
          </Text>
          {subheading ? <Text style={s.sub}>{subheading}</Text> : null}
          <View style={s.track}>
            <View style={[s.fill, {width: `${pct}%`}]} />
            {pending != null ? <View style={[s.knob, {left: `${pct}%`}]} /> : null}
          </View>
          <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
            <Text style={s.time}>
              {paused ? '❚❚  ' : ''}
              {clock(shown)}
            </Text>
            <Text style={s.time}>{live ? '▲▼ change channel' : total ? '−' + clock(total - shown) : ''}</Text>
          </View>
        </View>
      ) : null}
      {error ? (
        <View style={[StyleSheet.absoluteFill, {justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.8)', gap: 30}]}>
          <Text style={{color: '#FFFFFF', fontSize: 32, textAlign: 'center', maxWidth: 1200}}>⚠︎  {error}</Text>
          <View style={{flexDirection: 'row', gap: 24}}>
            <Button
              title="Try again"
              theme={store.theme}
              primary
              preferred
              onPress={() => {
                if (live) {
                  tune(channel.current);
                  return;
                }
                const from = holdAt.current ?? now();
                stopStream().then(() => current && begin(current, from));
              }}
            />
            <Button title="Close" theme={store.theme} onPress={close} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A few seconds after tuning in: the channel top right, now / next bottom left, and Vesper. */
function BugCard({bug}: {bug: Bug}) {
  const said = bug.host ? (bug.host.banter?.length ? `${bug.host.banter[0].who}: ${bug.host.banter[0].line}` : bug.host.line) : null;
  return (
    <View style={StyleSheet.absoluteFill}>
      {bug.channel ? (
        <View style={{position: 'absolute', top: 60, right: 60, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8}}>
          <Text style={[s.mono, {color: 'rgba(255,255,255,0.85)', fontSize: 28, fontWeight: '900'}]}>
            {bug.channel.number} {bug.name.toUpperCase()}
          </Text>
        </View>
      ) : null}
      <View style={{position: 'absolute', left: 60, bottom: 260, flexDirection: 'row', alignItems: 'flex-end', gap: 18}}>
        {bug.host && said ? <HostCard host={bug.host} text={said} size={190} /> : null}
        <View style={{backgroundColor: 'rgba(11,22,48,0.9)', borderRadius: 14, padding: 24, gap: 10, maxWidth: 1100}}>
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 14}}>
            <Text style={[s.mono, s.tag, {backgroundColor: G.yellow, color: '#000000'}]}>NOW</Text>
            <Text style={{color: '#FFFFFF', fontSize: 34, fontWeight: '700', flexShrink: 1}} numberOfLines={1}>
              {programLabel(bug.now)}
            </Text>
            <Text style={[s.mono, {color: G.cyan, fontSize: 22}]}>until {hm(bug.now.end)}</Text>
          </View>
          {bug.next ? (
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 14}}>
              <Text style={[s.mono, s.tag, {backgroundColor: G.line, color: '#FFFFFF'}]}>NEXT</Text>
              <Text style={{color: 'rgba(255,255,255,0.85)', fontSize: 26, fontWeight: '600', flexShrink: 1}} numberOfLines={1}>
                {programLabel(bug.next)}
              </Text>
              <Text style={[s.mono, {color: 'rgba(255,255,255,0.6)', fontSize: 22}]}>{hm(bug.next.start)}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Between shows: the channel's ident and a countdown. */
function Ident({bug, now}: {bug: Bug; now: number}) {
  const left = Math.max(0, Math.round((bug.startsAt ?? now) - now));
  const said = bug.host ? bug.host.line : null;
  return (
    <View style={[StyleSheet.absoluteFill, {backgroundColor: G.navy, justifyContent: 'center', alignItems: 'center', gap: 18}]}>
      {bug.channel ? <Text style={[s.mono, {color: G.yellow, fontSize: 120, fontWeight: '900'}]}>{bug.channel.number}</Text> : null}
      <Text style={[s.mono, {color: '#FFFFFF', fontSize: 54, fontWeight: '900'}]}>{bug.name.toUpperCase()}</Text>
      <Text style={{color: 'rgba(255,255,255,0.6)', fontSize: 28}}>{bug.tagline}</Text>
      {bug.host && said ? <HostCard host={bug.host} text={said} size={230} /> : null}
      <View style={{flexDirection: 'row', gap: 24, marginTop: 20, alignItems: 'center'}}>
        <Picture uri={bug.now.poster} style={{width: 120, height: 180, borderRadius: 8}} />
        <View style={{gap: 8, maxWidth: 900}}>
          <Text style={[s.mono, {color: G.cyan, fontSize: 22, fontWeight: '900'}]}>UP NEXT</Text>
          <Text style={{color: '#FFFFFF', fontSize: 38, fontWeight: '700'}} numberOfLines={2}>
            {programLabel(bug.now)}
          </Text>
          <Text style={[s.mono, {color: 'rgba(255,255,255,0.75)', fontSize: 26}]}>
            Starts in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 90, paddingTop: 60, paddingBottom: 60, backgroundColor: 'rgba(0,0,0,0.55)'},
  title: {color: '#FFFFFF', fontSize: 40, fontWeight: '800'},
  sub: {color: C.dim, fontSize: 26, marginTop: 6},
  track: {height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.3)', marginTop: 26, marginBottom: 14},
  fill: {height: 10, borderRadius: 5, backgroundColor: '#FFFFFF'},
  knob: {position: 'absolute', top: -9, width: 28, height: 28, marginLeft: -14, borderRadius: 14, backgroundColor: '#FFFFFF'},
  time: {color: '#FFFFFF', fontSize: 26, fontWeight: '600'},
  mono: {fontFamily: G.mono},
  tag: {fontSize: 22, fontWeight: '900', paddingHorizontal: 10, paddingVertical: 3},
});
