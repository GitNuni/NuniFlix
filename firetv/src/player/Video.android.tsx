// Android / Fire OS: react-native-video (ExoPlayer) plays the server's HLS directly. Same interface as Video.tsx.
import React, {useEffect, useRef, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import Video, {VideoRef} from 'react-native-video';
import type {Media, MediaEvent} from './Video';

export type {Media, MediaEvent} from './Video';

export function VideoSurface({onReady, onEvent}: {onReady: (m: Media) => void; onEvent: (e: MediaEvent, message?: string) => void}) {
  const ref = useRef<VideoRef>(null);
  const [src, setSrc] = useState<{uri: string; startPosition: number} | null>(null);
  const [paused, setPaused] = useState(true);
  const state = useRef({time: 0, duration: 0, paused: true, loaded: null as null | (() => void)});
  const events = useRef(onEvent);
  events.current = onEvent;

  useEffect(() => {
    const s = state.current;
    const media: Media = {
      load(url, from) {
        s.time = from;
        s.duration = 0;
        setSrc({uri: url, startPosition: Math.floor(from * 1000)});
        s.paused = false;
        setPaused(false);
        return new Promise<void>((ok) => (s.loaded = ok));
      },
      play() {
        s.paused = false;
        setPaused(false);
      },
      pause() {
        s.paused = true;
        setPaused(true);
      },
      seek(t) {
        ref.current?.seek(t);
        s.time = t;
      },
      stop() {
        s.paused = true;
        setPaused(true);
        setSrc(null);
      },
      get currentTime() {
        return s.time;
      },
      get duration() {
        return s.duration;
      },
      get paused() {
        return s.paused;
      },
    };
    onReady(media);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android only delivers remote presses to the app while something has focus, and the player has no buttons:
  // this invisible view holds focus so play/pause, skip and Back reach the player screen.
  return (
    <>
      {src ? (
        <Video
          ref={ref}
          source={{uri: src.uri, startPosition: src.startPosition}}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          paused={paused}
          controls={false}
          progressUpdateInterval={500}
          onLoad={(d) => {
            state.current.duration = d.duration;
            state.current.loaded?.();
            state.current.loaded = null;
          }}
          onProgress={(p) => (state.current.time = p.currentTime)}
          onBuffer={({isBuffering}) => events.current(isBuffering ? 'waiting' : 'playing')}
          onPlaybackStateChanged={({isPlaying}) => events.current(isPlaying ? 'playing' : state.current.paused ? 'paused' : 'waiting')}
          onEnd={() => events.current('ended')}
          onError={(e) => {
            events.current('error', plain(e.error?.errorString ?? e.error?.errorCode));
            state.current.loaded?.();
            state.current.loaded = null;
          }}
        />
      ) : null}
      <View focusable hasTVPreferredFocus style={StyleSheet.absoluteFill} />
    </>
  );
}

/** ExoPlayer's error codes, in words. */
function plain(code?: string): string {
  const c = code ?? '';
  if (/NETWORK|TIMEOUT|UNKNOWN_HOST/i.test(c)) return "Can't reach the video. Check the Fire TV's internet connection and try again.";
  if (/BAD_HTTP_STATUS|FILE_NOT_FOUND/i.test(c)) return 'The server stopped sending the video. Try again in a moment.';
  if (/DECOD|FORMAT|PARSING/i.test(c)) return "This Fire TV can't play that video format.";
  return 'The video wouldn’t play.';
}
