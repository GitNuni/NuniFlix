// Building blocks: focusable cards and buttons for the remote, pictures, badges, rows, grids.
// Mirrors apple/Sources/Views/Cards.swift.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import {Item, itemKey} from '../models';
import {M, ServiceTheme, tileSize, upper} from '../theme';
import {useStore} from '../store';
import {serverURL} from '../api';
import {DEMO_ART} from '../demoArt';

export const C = {
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.65)',
  faint: 'rgba(255,255,255,0.08)',
  red: '#FF453A',
  orange: '#FF9F0A',
  green: '#30D158',
  blue: '#0A84FF',
};

/** Something the remote can land on: grows a little and gets a white ring when focused. */
export function Focusable({
  onPress,
  style,
  focusedStyle,
  children,
  corner = 12,
  scale = 1.06,
  preferred,
  disabled,
  onFocus,
}: {
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  focusedStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode | ((focused: boolean) => React.ReactNode);
  corner?: number;
  scale?: number;
  preferred?: boolean;
  disabled?: boolean;
  onFocus?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => setFocused(false)}
      hasTVPreferredFocus={preferred}
      focusable={!disabled}
      style={[
        {borderRadius: corner + 4, borderWidth: 4, borderColor: 'transparent', opacity: disabled ? 0.5 : 1},
        style,
        focused && {borderColor: '#FFFFFF', transform: [{scale}]},
        focused && focusedStyle,
      ]}>
      {typeof children === 'function' ? children(focused) : children}
    </Pressable>
  );
}

/** A pill button: accent-coloured when it's the main action, glassy otherwise. */
export function Button({
  title,
  onPress,
  theme,
  primary,
  preferred,
  disabled,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  theme: ServiceTheme;
  primary?: boolean;
  preferred?: boolean;
  disabled?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Focusable onPress={onPress} preferred={preferred} disabled={disabled} corner={30} scale={1.05} style={style}>
      {(f) => (
        <View
          style={[
            s.button,
            {backgroundColor: f ? '#FFFFFF' : primary ? theme.accent : 'rgba(255,255,255,0.16)'},
          ]}>
          <Text style={[s.buttonText, {color: f ? '#000000' : primary ? theme.onAccent : '#FFFFFF'}]}>
            {icon ? `${icon}  ` : ''}
            {title}
          </Text>
        </View>
      )}
    </Focusable>
  );
}

/** A remote picture that fills its box (posters, backdrops), or with `fit` shows all of it (title logos). */
export function Picture({uri: given, label, style, fit}: {uri?: string | null; label?: string; style?: StyleProp<ViewStyle>; fit?: boolean}) {
  const [failed, setFailed] = useState(false);
  // a path on the NuniFlix server itself (shelf art, profile pictures)
  const uri = given ? serverURL(given) : given;
  return (
    <View style={[{backgroundColor: fit ? 'transparent' : C.faint, overflow: 'hidden', justifyContent: 'center', alignItems: 'center'}, style]}>
      {label && (!uri || failed) ? (
        <Text style={{color: C.dim, fontSize: 20, textAlign: 'center', padding: 8}} numberOfLines={3}>
          {label}
        </Text>
      ) : null}
      {uri && !failed ? (
        <Image source={uri.startsWith('demo:') ? DEMO_ART[uri] : {uri}} style={[StyleSheet.absoluteFill, {width: '100%', height: '100%'}]} resizeMode={fit ? 'contain' : 'cover'} onError={() => setFailed(true)} />
      ) : null}
    </View>
  );
}

export function statusText(status?: string, progress?: number): string | null {
  switch (status) {
    case 'available':
      return 'On server';
    case 'partial':
      return 'Some episodes';
    case 'pending':
      return 'Requested';
    case 'processing':
      return progress != null ? `Downloading ${Math.round(progress)}%` : 'On its way';
    default:
      return null;
  }
}

export function StatusBadge({status, progress}: {status?: string; progress?: number}) {
  const text = statusText(status, progress);
  if (!text) return null;
  const bg = status === 'available' ? C.green : status === 'partial' ? '#64D2FF' : status === 'pending' ? C.orange : C.blue;
  return (
    <View style={[s.badge, {backgroundColor: bg}]}>
      <Text style={s.badgeText}>{text}</Text>
    </View>
  );
}

export function Heading({theme, children, style}: {theme: ServiceTheme; children: string; style?: StyleProp<TextStyle>}) {
  return (
    <Text
      style={[
        {
          color: '#FFFFFF',
          fontSize: M.rowTitle,
          fontWeight: theme.rowWeight,
          fontStyle: theme.italic ? 'italic' : 'normal',
          fontFamily: theme.serif ? 'serif' : undefined,
          letterSpacing: theme.uppercase ? 1 : 0,
        },
        style,
      ]}>
      {upper(theme, children)}
    </Text>
  );
}

export function ItemCard({item, theme, onPress, preferred, onFocus}: {
  item: Item;
  theme: ServiceTheme;
  onPress: () => void;
  preferred?: boolean;
  onFocus?: () => void;
}) {
  const size = tileSize(theme);
  return (
    <Focusable onPress={onPress} corner={theme.corner} preferred={preferred} onFocus={onFocus}>
      <View style={{width: size.width, height: size.height, borderRadius: theme.corner, overflow: 'hidden'}}>
        {theme.tile === 'wide' ? (
          <>
            <Picture uri={item.backdrop ?? item.poster} label={item.title} style={StyleSheet.absoluteFill} />
            <View style={s.wideShade} />
            <Text style={s.wideTitle} numberOfLines={2}>
              {item.title ?? ''}
            </Text>
          </>
        ) : (
          <Picture uri={item.poster} label={item.title} style={StyleSheet.absoluteFill} />
        )}
        <View style={{position: 'absolute', top: 8, right: 8}}>
          <StatusBadge status={item.status} progress={item.progress} />
        </View>
      </View>
    </Focusable>
  );
}

function dedupe(list: Item[], seen: Set<string>): Item[] {
  return list.filter((it) => {
    const k = itemKey(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A titled sideways row of tiles. With `more`, it loads the next page when you reach the end. */
export function ItemRow({
  title,
  theme,
  items,
  more,
  preferredFirst,
  startPage = 1,
}: {
  title: string;
  theme: ServiceTheme;
  items: Item[];
  more?: (page: number) => Promise<Item[]>;
  preferredFirst?: boolean;
  startPage?: number; // pages already in `items`
}) {
  const {push} = useStore();
  const [list, setList] = useState(items);
  const page = useRef(startPage);
  const done = useRef(false);
  const loading = useRef(false);

  useEffect(() => {
    setList(items);
    page.current = startPage;
    done.current = false;
  }, [items, startPage]);

  const loadMore = useCallback(async () => {
    if (!more || done.current || loading.current) return;
    loading.current = true;
    const next = await more(page.current + 1);
    setList((cur) => {
      const fresh = dedupe(next, new Set(cur.map(itemKey)));
      if (fresh.length === 0) done.current = true;
      else page.current += 1;
      return fresh.length ? [...cur, ...fresh] : cur;
    });
    loading.current = false;
  }, [more]);

  const size = tileSize(theme);
  return (
    <View style={{marginBottom: M.spacing / 2}}>
      <Heading theme={theme} style={{marginHorizontal: M.gutter, marginBottom: 8}}>
        {title}
      </Heading>
      <FlatList
        horizontal
        data={list}
        keyExtractor={itemKey}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: M.gutter - 8, paddingVertical: 16}}
        ItemSeparatorComponent={() => <View style={{width: M.spacing / 2 - 8}} />}
        getItemLayout={(_, i) => ({length: size.width + M.spacing / 2, offset: (size.width + M.spacing / 2) * i, index: i})}
        onEndReached={loadMore}
        onEndReachedThreshold={2}
        initialNumToRender={8}
        windowSize={5}
        renderItem={({item, index}) => (
          <ItemCard
            item={item}
            theme={theme}
            preferred={preferredFirst && index === 0}
            onPress={() => push({name: 'item', item, theme})}
          />
        )}
      />
    </View>
  );
}

export function Loading({height = 300}: {height?: number}) {
  return (
    <View style={{height, justifyContent: 'center', alignItems: 'center'}}>
      <ActivityIndicator size="large" color="#FFFFFF" />
    </View>
  );
}

export function ErrorView({message, retry, theme}: {message: string; retry?: () => void; theme: ServiceTheme}) {
  return (
    <View style={{padding: 40, alignItems: 'center', gap: 20}}>
      <Text style={{color: '#FFFFFF', fontSize: 28, textAlign: 'center', maxWidth: 1100}}>⚠︎  {message}</Text>
      {retry ? <Button title="Try again" onPress={retry} theme={theme} preferred /> : null}
    </View>
  );
}

/** A full-screen message over everything, with OK. */
export function Notice({message, onClose, theme}: {message: string; onClose: () => void; theme: ServiceTheme}) {
  return (
    <View style={s.overlay}>
      <View style={s.sheet}>
        <Text style={{color: '#FFFFFF', fontSize: 30, textAlign: 'center', marginBottom: 30}}>{message}</Text>
        <Button title="OK" onPress={onClose} theme={theme} primary preferred />
      </View>
    </View>
  );
}

export function Background({theme, children, style}: {theme: ServiceTheme; children: React.ReactNode; style?: StyleProp<ViewStyle>}) {
  // Two stacked colours stand in for the gradient (no gradient view on Vega without a native module).
  return (
    <View style={[{flex: 1, backgroundColor: theme.background[theme.background.length - 1]}, style]}>
      <View style={[StyleSheet.absoluteFill, {backgroundColor: theme.background[0], bottom: '45%'}]} />
      <View style={[StyleSheet.absoluteFill, {backgroundColor: theme.background[0], opacity: 0.5, top: '55%', bottom: '25%'}]} />
      {children}
    </View>
  );
}

export const s = StyleSheet.create({
  button: {paddingHorizontal: 34, paddingVertical: 16, borderRadius: 30},
  buttonText: {fontSize: 26, fontWeight: '700'},
  badge: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, alignSelf: 'flex-start'},
  badgeText: {color: '#000000', fontSize: 18, fontWeight: '800'},
  wideShade: {position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', backgroundColor: 'rgba(0,0,0,0.55)'},
  wideTitle: {position: 'absolute', left: 12, right: 12, bottom: 10, color: '#FFFFFF', fontSize: 24, fontWeight: '700'},
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheet: {backgroundColor: '#1C1C1E', borderRadius: 24, padding: 50, minWidth: 700, maxWidth: 1200, alignItems: 'center'},
  dim: {color: 'rgba(255,255,255,0.65)'},
});
