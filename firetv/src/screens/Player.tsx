// Watching in the app, full screen. Like apple/Sources/Views/PlayerView.swift: the server finds the title on the
// person's own Plex/Jellyfin and passes the stream through (server/app/player.py); progress goes back every
// 10 seconds so Plex/Jellyfin keep the resume point and history; at the end it moves on to the next episode.
//
// Remote: Play/Pause or Select pauses; Left/Right skip 10 s (press again to go further); Rewind/Fast-forward skip
// 30 s; Up/Down show where you are; Back leaves.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, StyleSheet, Text, View} from 'react-native';
import {useTVEventHandler} from '@amazon-devices/react-native-kepler';
import {KeplerVideoSurfaceView, VideoPlayer} from '@amazon-devices/react-native-w3cmedia';
import {api, errorText} from '../api';
import {clock, episodeCode, PlayItem, StreamStart} from '../models';
import {useStore} from '../store';
import {Hls} from '../player/hls';
import {log} from '../log';
import {Button, C} from '../components/ui';

const PLATFORM = 'firetv';

export function PlayerScreen({title, queue, at}: {title: string; queue: PlayItem[]; at: number}) {
  const store = useStore();
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState(at);
  const [duration, setDuration] = useState(queue[0]?.duration ?? 0);
  const [paused, setPaused] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState(true);
  const [pending, setPending] = useState<number | null>(null); // where a run of skips will land

  const player = useRef<VideoPlayer | null>(null);
  const surface = useRef<string | null>(null);
  const engine = useRef<Hls | null>(null);
  const session = useRef<string | null>(null);
  const holdAt = useRef<number | null>(null); // until playback reaches the resume point, report that instead of 0:00
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<number | null>(null);
  const closed = useRef(false);
  const current = queue[index];

  const now = () => player.current?.currentTime ?? 0;

  const poke = useCallback((stay?: boolean) => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!stay) hideTimer.current = setTimeout(() => setControls(false), 4000);
  }, []);

  const report = useCallback((state: 'playing' | 'paused' | 'stopped') => {
    const sid = session.current;
    if (!sid) return Promise.resolve();
    if (state === 'stopped') session.current = null;
    const pos = holdAt.current ?? now();
    return api
      .post('/play/progress', {session: sid, position: pos, duration: engine.current?.duration || duration, state})
      .then(
        () => {},
        () => {},
      );
  }, [duration]);

  const stopStream = useCallback(async () => {
    engine.current?.destroy();
    engine.current = null;
    await report('stopped');
  }, [report]);

  /** Starts one movie/episode at `from` seconds. */
  const begin = useCallback(
    async (item: PlayItem, from: number) => {
      const vp = player.current;
      if (!vp) return;
      setWaiting(true);
      setError(null);
      setPosition(from);
      setDuration(item.duration);
      holdAt.current = from > 0 ? from : null;
      try {
        const [text] = await api.post('/play/start', {id: item.id, offset: 0, at: from, platform: PLATFORM});
        const s = JSON.parse(text) as StreamStart;
        if (closed.current) {
          api.post('/play/progress', {session: s.session, position: from, state: 'stopped'}).catch(() => {});
          return;
        }
        session.current = s.session;
        const hls = new Hls(vp, api.base + s.url);
        hls.onLog = (m) => log('hls', m);
        hls.onError = (m) => setError(m);
        engine.current = hls;
        await hls.start(from);
        if (closed.current || engine.current !== hls) return;
        if (hls.duration) setDuration(hls.duration);
        await vp.play();
      } catch (e) {
        log('start failed', errorText(e));
        if (!closed.current) setError(errorText(e) ?? 'The video wouldn’t start.');
      }
    },
    [],
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
      vp.addEventListener('ended', () => setIndex((i) => i + 1));
      begin(queue[0], at);
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

  // the clock on screen, and progress to the server every 10 s
  useEffect(() => {
    const t = setInterval(() => {
      const p = now();
      if (holdAt.current != null && Math.abs(p - holdAt.current) < 15 && p > 0) holdAt.current = null;
      setPosition(p);
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
      case 'down':
      case 'menu':
      case 'info':
        poke();
        break;
    }
  });

  const shown = pending ?? position;
  const total = engine.current?.duration || duration;
  const label = [episodeCode(current ?? ({} as PlayItem)), current?.title && current.title !== title ? current.title : null]
    .filter(Boolean)
    .join('  ·  ');

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
      {waiting && !error ? (
        <View style={[StyleSheet.absoluteFill, {justifyContent: 'center', alignItems: 'center'}]}>
          <ActivityIndicator size="large" color="#FFFFFF" />
        </View>
      ) : null}
      {(controls || paused || pending != null) && !error ? (
        <View style={s.bar}>
          <Text style={s.title} numberOfLines={1}>
            {title}
          </Text>
          {label ? <Text style={s.sub}>{label}</Text> : null}
          <View style={s.track}>
            <View style={[s.fill, {width: `${total ? Math.min(100, (shown / total) * 100) : 0}%`}]} />
            {pending != null ? <View style={[s.knob, {left: `${total ? Math.min(100, (shown / total) * 100) : 0}%`}]} /> : null}
          </View>
          <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
            <Text style={s.time}>
              {paused ? '❚❚  ' : ''}
              {clock(shown)}
            </Text>
            <Text style={s.time}>{total ? '−' + clock(total - shown) : ''}</Text>
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

const s = StyleSheet.create({
  bar: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 90, paddingTop: 60, paddingBottom: 60, backgroundColor: 'rgba(0,0,0,0.55)'},
  title: {color: '#FFFFFF', fontSize: 40, fontWeight: '800'},
  sub: {color: C.dim, fontSize: 26, marginTop: 6},
  track: {height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.3)', marginTop: 26, marginBottom: 14},
  fill: {height: 10, borderRadius: 5, backgroundColor: '#FFFFFF'},
  knob: {position: 'absolute', top: -9, width: 28, height: 28, marginLeft: -14, borderRadius: 14, backgroundColor: '#FFFFFF'},
  time: {color: '#FFFFFF', fontSize: 26, fontWeight: '600'},
});
