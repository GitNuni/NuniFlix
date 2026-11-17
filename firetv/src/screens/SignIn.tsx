// First run: which server, then sign in with a code approved on your phone (no typing passwords with a remote).
// Mirrors apple/Sources/Views/SignInViews.swift.
import React, {useEffect, useMemo, useState} from 'react';
import {ScrollView, Text, TextInput, View} from 'react-native';
import qrcode from 'qrcode-generator';
import {api, ApiError, errorText, normalizeServer} from '../api';
import {AuthOptions, TVCode} from '../models';
import {DEVICE_NAME, useStore} from '../store';
import {upper} from '../theme';
import {Background, Button, C, Focusable} from '../components/ui';

function Field({value, onChange, placeholder, secure, onSubmit, preferred}: {
  value: string;
  onChange: (s: string) => void;
  placeholder: string;
  secure?: boolean;
  onSubmit?: () => void;
  preferred?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor="rgba(255,255,255,0.35)"
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
      onSubmitEditing={onSubmit}
      hasTVPreferredFocus={preferred}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: 900,
        fontSize: 30,
        color: '#FFFFFF',
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 14,
        paddingHorizontal: 24,
        paddingVertical: 18,
        borderWidth: 4,
        borderColor: focused ? '#FFFFFF' : 'transparent',
      }}
    />
  );
}

export function ServerScreen() {
  const store = useStore();
  const theme = store.theme;
  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    let url: string;
    try {
      url = normalizeServer(address);
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setChecking(true);
    setError(null);
    const ok = await api.check(url);
    setChecking(false);
    if (ok) await store.setServer(url);
    else setError('No NuniFlix there. Check the address, and that your Fire TV is on the same network (or use the https address).');
  }

  return (
    <Background theme={theme}>
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30, padding: 80}}>
        <Text style={{color: theme.brand, fontSize: 96, fontWeight: '900'}}>{upper(theme, 'NuniFlix')}</Text>
        <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '600'}}>What's your NuniFlix address?</Text>
        <Text style={{color: C.dim, fontSize: 26, textAlign: 'center'}}>
          The same one you open in the browser, like http://192.168.0.49:8095 or https://requests.example.com
        </Text>
        <Field value={address} onChange={setAddress} placeholder="http://192.168.0.49:8095" onSubmit={connect} preferred />
        {error ? <Text style={{color: C.red, fontSize: 26, textAlign: 'center', maxWidth: 1200}}>{error}</Text> : null}
        <Button title={checking ? 'Checking…' : 'Connect'} onPress={connect} theme={theme} primary disabled={checking || !address.trim()} />
      </View>
    </Background>
  );
}

/** The QR code as a grid of squares (no image or SVG module needed). */
function QR({text, size}: {text: string; size: number}) {
  const rows = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const out: boolean[][] = [];
    for (let r = 0; r < n; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
      out.push(row);
    }
    return out;
  }, [text]);
  const cell = Math.floor(size / rows.length);
  return (
    <View style={{backgroundColor: '#FFFFFF', padding: 24, borderRadius: 24}}>
      {rows.map((row, r) => (
        <View key={r} style={{flexDirection: 'row'}}>
          {runs(row).map(([dark, len], i) => (
            <View key={i} style={{width: cell * len, height: cell, backgroundColor: dark ? '#000000' : '#FFFFFF'}} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** [dark, length] runs, so a row is a few boxes instead of one per square. */
function runs(row: boolean[]): [boolean, number][] {
  const out: [boolean, number][] = [];
  for (const d of row) {
    const last = out[out.length - 1];
    if (last && last[0] === d) last[1]++;
    else out.push([d, 1]);
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));

function TVCodeView() {
  const store = useStore();
  const [code, setCode] = useState<TVCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Get a code, then ask every couple of seconds whether someone approved it. New code when it expires.
      while (alive) {
        try {
          const [text] = await api.post('/auth/tv/start');
          const c = JSON.parse(text) as TVCode;
          if (!alive) return;
          setCode(c);
          setError(null);
          const until = Date.now() + (c.expires - 10) * 1000;
          while (alive && Date.now() < until) {
            await sleep(2500);
            if (!alive) return;
            try {
              const [d, status] = await api.post('/auth/tv/check', {state: c.state, device: DEVICE_NAME});
              if (status === 200) {
                await store.didSignIn(d);
                return;
              }
            } catch (e) {
              if (e instanceof ApiError && e.status === 410) break; // expired: get a new code
              if (e instanceof ApiError && e.status === 0) continue; // network blip: keep waiting
              throw e;
            }
          }
        } catch (e) {
          if (!alive) return;
          setError(errorText(e));
          await sleep(5000);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spaced = code ? code.code.slice(0, 3) + ' ' + code.code.slice(3) : '··· ···';
  return (
    <View style={{flexDirection: 'row', alignItems: 'center', gap: 80}}>
      {code ? <QR text={code.url} size={340} /> : <View style={{width: 388, height: 388}} />}
      <View style={{maxWidth: 900, gap: 18}}>
        <Text style={{color: '#FFFFFF', fontSize: 40, fontWeight: '700'}}>Sign in with your phone</Text>
        <Text style={{color: C.dim, fontSize: 26}}>
          Scan the code with your phone's camera, or open this address in NuniFlix on your phone or computer:
        </Text>
        <Text style={{color: '#FFFFFF', fontSize: 32, fontFamily: 'monospace'}}>{code?.link ?? ' '}</Text>
        <Text style={{color: C.dim, fontSize: 26}}>and enter</Text>
        <Text style={{color: '#FFFFFF', fontSize: 96, fontWeight: '900', fontFamily: 'monospace', letterSpacing: 6}}>{spaced}</Text>
        {error ? <Text style={{color: C.red, fontSize: 24}}>{error}</Text> : null}
      </View>
    </View>
  );
}

function JellyfinForm() {
  const store = useStore();
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const [d] = await api.post('/auth/jellyfin', {username: user, password: pass, device: DEVICE_NAME});
      await store.didSignIn(d);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <View style={{gap: 16, alignItems: 'center'}}>
      <Field value={user} onChange={setUser} placeholder="Jellyfin username" preferred />
      <Field value={pass} onChange={setPass} placeholder="Password" secure onSubmit={submit} />
      {error ? <Text style={{color: C.red, fontSize: 24}}>{error}</Text> : null}
      <Button title={busy ? 'Signing in…' : 'Sign in'} onPress={submit} theme={store.theme} primary disabled={!user || busy} />
    </View>
  );
}

export function SignInScreen() {
  const store = useStore();
  const theme = store.theme;
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    api.get<AuthOptions>('/auth/options').then(setOptions, (e) => setError(errorText(e)));
  }, []);

  const host = store.server?.replace(/^https?:\/\//, '') ?? '';
  return (
    <Background theme={theme}>
      <ScrollView contentContainerStyle={{alignItems: 'center', padding: 80, gap: 50, minHeight: 1080, justifyContent: 'center'}}>
        <View style={{alignItems: 'center', gap: 8}}>
          <Text style={{color: theme.brand, fontSize: 96, fontWeight: '900'}}>{upper(theme, store.brand)}</Text>
          <Text style={{color: C.dim, fontSize: 22, fontFamily: 'monospace'}}>{host}</Text>
        </View>
        <TVCodeView />
        {options?.jellyfin ? (
          <>
            <Focusable onPress={() => setShowPassword(!showPassword)} corner={20}>
              <Text style={{color: '#FFFFFF', fontSize: 26, paddingHorizontal: 24, paddingVertical: 12}}>
                {showPassword ? 'Hide' : 'Sign in with a Jellyfin username and password'}
              </Text>
            </Focusable>
            {showPassword ? <JellyfinForm /> : null}
          </>
        ) : null}
        {error ? <Text style={{color: C.red, fontSize: 24}}>{error}</Text> : null}
        <Focusable onPress={() => store.clearServer()} corner={20}>
          <Text style={{color: C.dim, fontSize: 22, paddingHorizontal: 20, paddingVertical: 10}}>Use a different server</Text>
        </Focusable>
      </ScrollView>
    </Background>
  );
}
