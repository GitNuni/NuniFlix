import React, {useEffect, useRef} from 'react';
import {BackHandler, StatusBar, useWindowDimensions, View} from 'react-native';
import {Entry, StoreProvider, useStore} from './store';
import {ServerScreen, SignInScreen} from './screens/SignIn';
import {BrowseGridScreen, SearchScreen, SectionScreen, ServiceHomeScreen, SettingsScreen} from './screens/Browse';
import {LibraryScreen, ProfilePicker, ServicesScreen, ShelfScreen, YourFlixScreen} from './screens/Home';
import {LiveScreen} from './screens/Live';
import {DetailScreen} from './screens/Detail';
import {PlayerScreen} from './screens/Player';
import {Loading} from './components/ui';

function Screen({entry}: {entry: Entry}) {
  const r = entry.route;
  switch (r.name) {
    case 'services':
      return <ServicesScreen />;
    case 'yourflix':
      return <YourFlixScreen />;
    case 'service':
      return <ServiceHomeScreen provider={r.provider} />;
    case 'section':
      return <SectionScreen provider={r.provider} title={r.title} type={r.type} cat={r.cat} />;
    case 'browse':
      return <BrowseGridScreen provider={r.provider} title={r.title} query={r.query} />;
    case 'search':
      return <SearchScreen provider={r.provider} />;
    case 'item':
      return <DetailScreen item={r.item} theme={r.theme} />;
    case 'settings':
      return <SettingsScreen />;
    case 'library':
      return <LibraryScreen genre={r.genre} />;
    case 'shelf':
      return <ShelfScreen shelf={r.shelf} />;
    case 'live':
      return <LiveScreen />;
    case 'player':
      return <PlayerScreen title={r.title} queue={r.queue} at={r.at} live={r.live} />;
  }
}

/** Signed in: the screen stack. Only the top screen is shown; Back goes down one, and leaves the app from home. */
function Main() {
  const store = useStore();
  // Registered once, so it's always the last to hear Back: the player and open overlays (registered later) go first.
  const ref = useRef(store);
  ref.current = store;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => ref.current.pop());
    return () => sub.remove();
  }, []);
  const top = store.stack[store.stack.length - 1];
  // "Who's watching?" replaces the screen while it's up, so the remote can't wander onto what's behind it
  return store.choosingProfile ? <ProfilePicker /> : <Screen key={top.key} entry={top} />;
}

function Root() {
  const store = useStore();
  if (!store.ready) return <Loading height={1080} />;
  if (!store.server) return <ServerScreen />;
  if (!store.signedIn) return <SignInScreen />;
  return <Main />;
}

/** Every screen is laid out for 1920x1080 (like the Apple TV app) and scaled to whatever size the TV reports,
 *  so sizes look the same on every Fire TV. */
function Canvas({children}: {children: React.ReactNode}) {
  const {width, height} = useWindowDimensions();
  const k = Math.min(width / 1920, height / 1080);
  return (
    <View style={{flex: 1, backgroundColor: '#000000', overflow: 'hidden'}}>
      <View
        style={{
          width: 1920,
          height: 1080,
          transform: [{translateX: (width - 1920) / 2}, {translateY: (height - 1080) / 2}, {scale: k}],
        }}>
        {children}
      </View>
    </View>
  );
}

export const App = () => (
  <StoreProvider>
    <StatusBar hidden />
    <Canvas>
      <Root />
    </Canvas>
  </StoreProvider>
);
