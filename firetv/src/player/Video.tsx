// The picture and the playback underneath the player screen, the same shape on both platforms.
// Vega (this file): Amazon's W3C media player, fed by our own HLS loader (hls.ts).
// Android / Fire OS (Video.android.tsx): react-native-video (ExoPlayer), which plays HLS by itself.
import React, {useEffect, useRef} from 'react';
import {StyleSheet} from 'react-native';
import {KeplerVideoSurfaceView, VideoPlayer} from '@amazon-devices/react-native-w3cmedia';
import {Hls} from './hls';
import {log} from '../log';

export type MediaEvent = 'waiting' | 'playing' | 'paused' | 'ended' | 'error';

/** What the player screen drives. */
export interface Media {
  /** Starts a stream at `from` seconds and plays it. */
  load(url: string, from: number): Promise<void>;
  play(): void;
  pause(): void;
  seek(t: number): void;
  /** Ends the stream (the screen then reports "stopped"). */
  stop(): void;
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
}

export function VideoSurface({onReady, onEvent}: {onReady: (m: Media) => void; onEvent: (e: MediaEvent, message?: string) => void}) {
  const surface = useRef<string | null>(null);
  const player = useRef<VideoPlayer | null>(null);
  const events = useRef(onEvent);
  events.current = onEvent;

  useEffect(() => {
    const vp = new VideoPlayer();
    let alive = true;
    let engine: Hls | null = null;
    vp.initialize().then(() => {
      if (!alive) return;
      player.current = vp;
      vp.autoplay = false;
      if (surface.current) vp.setSurfaceHandle(surface.current);
      const on = (name: string, e: MediaEvent) => vp.addEventListener(name, () => events.current(e));
      on('waiting', 'waiting');
      on('playing', 'playing');
      on('canplay', 'playing');
      on('play', 'playing');
      on('pause', 'paused');
      on('ended', 'ended');
      vp.addEventListener('error', () => events.current('error', (vp as any).error?.message));
      const media: Media = {
        async load(url, from) {
          engine?.destroy();
          const hls = new Hls(vp, url);
          hls.onLog = (m) => log('hls', m);
          hls.onError = (m) => events.current('error', m);
          engine = hls;
          await hls.start(from);
          if (engine === hls && alive) await vp.play();
        },
        play: () => vp.play(),
        pause: () => vp.pause(),
        seek: (t) => engine?.seek(t),
        stop() {
          engine?.destroy();
          engine = null;
          try {
            vp.pause();
          } catch {}
        },
        get currentTime() {
          return vp.currentTime || 0;
        },
        get duration() {
          return engine?.duration || 0;
        },
        get paused() {
          return vp.paused;
        },
      };
      onReady(media);
    });
    return () => {
      alive = false;
      engine?.destroy();
      try {
        vp.pause();
        vp.deinitialize();
      } catch {}
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
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
  );
}
