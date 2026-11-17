// Live TV: channels made from the person's own Plex/Jellyfin, laid out like old TV (server: channels.py). The guide
// shows what's on now and next; picking a channel tunes in part-way through whatever it's showing. In the player,
// Up/Down flip channels. Vesper, the host, says hello (server: host.py). Mirrors apple/Sources/Views/LiveViews.swift.
import React, {useCallback, useEffect, useState} from 'react';
import {FlatList, StyleSheet, Text, View} from 'react-native';
import {api, errorText} from '../api';
import {HostSays, hm, LiveChannel, LiveLineup, LiveProgram, liveTZ, onNow, programLabel} from '../models';
import {useStore} from '../store';
import {ErrorView, Focusable, Loading, Picture} from '../components/ui';

export const G = {
  navy: '#0B1630',
  yellow: '#FFD23F',
  cyan: '#5CE1E6',
  line: '#2A3A66',
  red: '#E50914',
  mono: 'monospace',
};

export function LiveScreen() {
  const store = useStore();
  const [lineup, setLineup] = useState<LiveLineup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ch: LiveChannel; p: LiveProgram} | null>(null);
  const [line, setLine] = useState(0);
  const [clock, setClock] = useState(Date.now() / 1000);

  const load = useCallback(async () => {
    try {
      const l = await api.get<LiveLineup>('/live', {hours: '4', tz: liveTZ()});
      setLineup(l);
      setError(null);
      setShown((cur) => {
        if (cur) {
          const ch = l.channels.find((c) => c.key === cur.ch.key);
          const p = ch && onNow(ch);
          if (ch && p) return {ch, p};
        }
        const ch = l.channels[0];
        const p = ch && (onNow(ch) ?? ch.programs[0]);
        return ch && p ? {ch, p} : null;
      });
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    load();
    const refresh = setInterval(load, 120000); // keep the guide current while it's open
    const talk = setInterval(() => setLine((n) => n + 1), 15000); // Vesper has more than one thing to say
    const tick = setInterval(() => setClock(Date.now() / 1000), 30000);
    return () => {
      clearInterval(refresh);
      clearInterval(talk);
      clearInterval(tick);
    };
  }, [load]);

  const tune = (ch: LiveChannel) => {
    if (!lineup) return;
    store.push({name: 'player', title: ch.name, queue: [], at: 0, live: {key: ch.key, channels: lineup.channels}});
  };

  if (error && !lineup) {
    return (
      <View style={{flex: 1, backgroundColor: G.navy, justifyContent: 'center'}}>
        <ErrorView message={error} retry={load} theme={store.theme} />
      </View>
    );
  }
  if (!lineup) {
    return (
      <View style={{flex: 1, backgroundColor: G.navy, justifyContent: 'center', alignItems: 'center'}}>
        <Loading />
        <Text style={{color: '#FFFFFF', fontSize: 28}}>Warming up the channels…</Text>
      </View>
    );
  }
  if (!lineup.channels.length) {
    return (
      <View style={{flex: 1, backgroundColor: G.navy, justifyContent: 'center', alignItems: 'center'}}>
        <Focusable preferred corner={12}>
          <Text style={{color: '#FFFFFF', fontSize: 30, padding: 12}}>No channels yet. Live TV is made from what's on your Plex or Jellyfin.</Text>
        </Focusable>
      </View>
    );
  }

  return (
    <View style={{flex: 1, backgroundColor: G.navy}}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: '#000000', top: '50%', opacity: 0.6}]} />
      {shown ? <Preview ch={shown.ch} p={shown.p} host={lineup.host} line={line} now={clock} /> : null}
      <View style={{flexDirection: 'row', paddingHorizontal: 90, paddingBottom: 8}}>
        <Text style={[s.mono, {width: 380, color: 'rgba(255,255,255,0.5)'}]}>CHANNEL</Text>
        <Text style={[s.mono, {flex: 1, color: 'rgba(255,255,255,0.5)'}]}>ON NOW</Text>
        <Text style={[s.mono, {width: 560, color: 'rgba(255,255,255,0.5)'}]}>NEXT</Text>
      </View>
      <FlatList
        data={lineup.channels}
        keyExtractor={(c) => c.key}
        contentContainerStyle={{paddingHorizontal: 82, paddingBottom: 60}}
        initialNumToRender={8}
        windowSize={5}
        renderItem={({item: ch, index}) => (
          <ChannelRow ch={ch} now={clock} preferred={index === 0} onFocus={(p) => setShown({ch, p})} onPress={() => tune(ch)} />
        )}
      />
    </View>
  );
}

function ChannelRow({ch, now, preferred, onFocus, onPress}: {
  ch: LiveChannel;
  now: number;
  preferred: boolean;
  onFocus: (p: LiveProgram) => void;
  onPress: () => void;
}) {
  const cur = onNow(ch, now);
  const next = cur ? ch.programs[ch.programs.indexOf(cur) + 1] : undefined;
  const pct = cur ? Math.min(100, Math.max(0, ((now - cur.start) / Math.max(1, cur.end - cur.start)) * 100)) : 0;
  return (
    <Focusable preferred={preferred} corner={10} scale={1.01} onPress={onPress} onFocus={() => cur && onFocus(cur)} style={{marginBottom: 6}}>
      {(f) => (
        <View style={{flexDirection: 'row', alignItems: 'center', height: 92, borderRadius: 10, backgroundColor: f ? '#1E2D57' : 'rgba(255,255,255,0.05)', paddingHorizontal: 16}}>
          <View style={{width: 364, flexDirection: 'row', alignItems: 'center', gap: 16}}>
            <Text style={[s.mono, {fontSize: 34, fontWeight: '900', color: G.yellow, width: 70, textAlign: 'right'}]}>{ch.number}</Text>
            <View style={{flex: 1}}>
              <Text style={{color: ch.takeover ? '#FF5468' : '#FFFFFF', fontSize: 25, fontWeight: '700'}} numberOfLines={1}>
                {ch.name}
              </Text>
              <Text style={{color: ch.takeover ? '#FF5468' : 'rgba(255,255,255,0.5)', fontSize: 17, fontWeight: ch.takeover ? '900' : '400'}}>
                {ch.takeover ? 'TAKEOVER' : ch.kind === 'tv' ? 'Shows' : 'Movies'}
              </Text>
            </View>
          </View>
          <View style={{flex: 1, paddingRight: 20}}>
            <Text style={{color: '#FFFFFF', fontSize: 25, fontWeight: '600'}} numberOfLines={1}>
              {cur ? programLabel(cur) : '—'}
            </Text>
            <View style={{height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.15)', marginTop: 10}}>
              <View style={{height: 5, borderRadius: 3, width: `${pct}%`, backgroundColor: G.red}} />
            </View>
          </View>
          <Text style={{width: 560, color: 'rgba(255,255,255,0.65)', fontSize: 22}} numberOfLines={1}>
            {next ? `${hm(next.start)}  ${programLabel(next)}` : ''}
          </Text>
        </View>
      )}
    </Focusable>
  );
}

/** The focused channel's programme, big, with Vesper saying something beside it. */
function Preview({ch, p, host, line, now}: {ch: LiveChannel; p: LiveProgram; host?: HostSays; line: number; now: number}) {
  const live = p.start <= now && now < p.end;
  const lines = host?.banter?.length ? host.banter.map((b) => `${b.who}: ${b.line}`) : host?.lines?.length ? host.lines : host ? [host.line] : [];
  const said = lines.length ? lines[line % lines.length] : null;
  return (
    <View style={{flexDirection: 'row', paddingHorizontal: 90, paddingTop: 50, height: 450, gap: 40}}>
      <View style={{flex: 1, gap: 10}}>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 14}}>
          <View style={{width: 14, height: 14, borderRadius: 7, backgroundColor: 'red'}} />
          <Text style={[s.mono, {fontSize: 24, fontWeight: '900', color: '#FFFFFF'}]}>LIVE TV</Text>
          <Text style={[s.mono, {fontSize: 24, color: 'rgba(255,255,255,0.6)'}]}>{hm(now)}</Text>
        </View>
        <Text style={[s.mono, {fontSize: 26, fontWeight: '800', color: G.yellow}]}>
          {ch.number}  {ch.name.toUpperCase()}
        </Text>
        <Text style={{color: '#FFFFFF', fontSize: 52, fontWeight: '900'}} numberOfLines={1}>
          {p.show ?? p.title ?? ''}
        </Text>
        <Text style={{color: G.cyan, fontSize: 24, fontWeight: '600'}}>
          {[p.show ? p.title : null, p.sub, `${hm(p.start)} – ${hm(p.end)}`, live ? `${Math.max(1, Math.round((p.end - now) / 60))} min left` : null]
            .filter(Boolean)
            .join('  ·  ')}
        </Text>
        <Text style={{color: 'rgba(255,255,255,0.75)', fontSize: 22, maxWidth: 900}} numberOfLines={3}>
          {p.overview ?? ch.tagline}
        </Text>
      </View>
      {host && said ? <HostCard host={host} text={said} /> : null}
      <View style={{width: 560, height: 315, borderRadius: 12, overflow: 'hidden'}}>
        <Picture uri={p.backdrop ?? p.poster} style={StyleSheet.absoluteFill} />
        {live ? (
          <View style={{position: 'absolute', left: 12, bottom: 12, backgroundColor: G.red, paddingHorizontal: 10, paddingVertical: 4}}>
            <Text style={[s.mono, {color: '#FFFFFF', fontSize: 18, fontWeight: '900'}]}>ON NOW</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Vesper (or Lucy) and a speech bubble. Her picture is on the server (web/host/<mood>.png). */
export function HostCard({host, text, size = 170}: {host: HostSays; text: string; size?: number}) {
  const lucy = text.startsWith(`${host.guest?.name ?? 'Lucy'}:`) && host.guest;
  const mood = lucy ? (host.guest!.mood === 'scared' ? 'lucy-scared' : 'lucy') : host.mood;
  return (
    <View style={{flexDirection: 'row', alignItems: 'flex-start', width: 250 + size, paddingTop: 110}}>
      <View style={{backgroundColor: '#FFFFFF', borderRadius: 10, padding: 10, width: 250}}>
        <Text style={{color: '#000000', fontSize: 19, fontWeight: '600'}} numberOfLines={5}>
          {text}
        </Text>
      </View>
      <Picture uri={`/host/${mood}.png`} style={{width: size, height: size, backgroundColor: 'transparent'}} fit />
    </View>
  );
}

const s = StyleSheet.create({
  mono: {fontFamily: G.mono, fontSize: 20},
});
