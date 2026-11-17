// Which server, who's signed in, the theme, and the screen stack. Mirrors apple/Sources/Core/AppModel.swift.
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import {api, ApiError} from './api';
import {AuthOptions, Item, Me, PlayItem, Provider} from './models';
import {appTheme, NUNIFLIX, ServiceTheme} from './theme';

export const DEVICE_NAME = 'Fire TV';

export type Route =
  | {name: 'services'}
  | {name: 'yourflix'}
  | {name: 'service'; provider: Provider}
  | {name: 'section'; provider: Provider; title: string; type: string; cat?: string}
  | {name: 'browse'; provider: Provider; title: string; query: Record<string, string>}
  | {name: 'search'; provider?: Provider}
  | {name: 'item'; item: Item; theme: ServiceTheme}
  | {name: 'settings'}
  | {name: 'player'; title: string; queue: PlayItem[]; at: number};

export interface Entry {
  key: number;
  route: Route;
}

interface Store {
  ready: boolean;
  server: string | null;
  signedIn: boolean;
  me: Me | null;
  brand: string;
  themeId: string;
  theme: ServiceTheme;
  setServer(url: string): Promise<void>;
  clearServer(): Promise<void>;
  didSignIn(text: string): Promise<void>;
  signOut(): Promise<void>;
  setTheme(id: string): Promise<void>;
  loadMe(): Promise<void>;
  // navigation
  stack: Entry[];
  push(r: Route): void;
  pop(): boolean;
  popToRoot(): void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('no store');
  return s;
}

export function StoreProvider({children}: {children: React.ReactNode}) {
  const [ready, setReady] = useState(false);
  const [server, setServerState] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [brand, setBrand] = useState('NuniFlix');
  const [themeId, setThemeId] = useState('nuniflix');
  const [stack, setStack] = useState<Entry[]>([{key: 0, route: {name: 'services'}}]);
  const nextKey = useRef(1);

  const forget = useCallback(async () => {
    await AsyncStorage.removeItem('token');
    api.token = null;
    setSignedIn(false);
    setMe(null);
    setStack([{key: 0, route: {name: 'services'}}]);
  }, []);

  useEffect(() => {
    (async () => {
      const [s, tok, th] = await Promise.all([
        AsyncStorage.getItem('server'),
        AsyncStorage.getItem('token'),
        AsyncStorage.getItem('theme'),
      ]);
      api.base = s;
      api.token = tok;
      setServerState(s);
      if (th) setThemeId(th);
      setSignedIn(!!s && !!tok);
      setReady(true);
    })();
    api.onUnauthorized = () => {
      forget();
    };
  }, [forget]);

  const loadMe = useCallback(async () => {
    try {
      const m = await api.get<Me>('/me');
      setMe(m);
      if (m.prefs?.theme) {
        setThemeId(m.prefs.theme);
        AsyncStorage.setItem('theme', m.prefs.theme);
      }
    } catch {}
    try {
      const o = await api.get<AuthOptions>('/auth/options');
      if (o.name) setBrand(o.name.endsWith('Flix') ? o.name : o.name + 'Flix');
    } catch {}
  }, []);

  useEffect(() => {
    if (signedIn) loadMe();
  }, [signedIn, loadMe]);

  const value = useMemo<Store>(
    () => ({
      ready,
      server,
      signedIn,
      me,
      brand,
      themeId,
      theme: appTheme(themeId) ?? NUNIFLIX,
      async setServer(url) {
        api.base = url;
        await AsyncStorage.setItem('server', url);
        setServerState(url);
      },
      async clearServer() {
        try {
          await api.post('/auth/logout');
        } catch {}
        await forget();
        api.base = null;
        await AsyncStorage.removeItem('server');
        setServerState(null);
      },
      async didSignIn(text) {
        const s = JSON.parse(text) as {token?: string};
        if (!s.token) throw new ApiError(0, 'The server sent something unexpected. Is NuniFlix up to date?');
        api.token = s.token;
        await AsyncStorage.setItem('token', s.token);
        setSignedIn(true);
      },
      async signOut() {
        try {
          await api.post('/auth/logout');
        } catch {}
        await forget();
      },
      async setTheme(id) {
        setThemeId(id);
        await AsyncStorage.setItem('theme', id);
        try {
          await api.post('/me/prefs', {theme: id});
        } catch {}
      },
      loadMe,
      stack,
      push(r) {
        const key = nextKey.current++;
        setStack((s) => [...s, {key, route: r}]);
      },
      pop() {
        if (stack.length <= 1) return false;
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
        return true;
      },
      popToRoot() {
        setStack((s) => s.slice(0, 1));
      },
    }),
    [ready, server, signedIn, me, brand, themeId, stack, forget, loadMe],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
