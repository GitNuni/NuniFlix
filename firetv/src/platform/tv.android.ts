// Remote buttons on Android TV / Fire OS: react-native-tvos has the same hook. It reports a button when it's
// released (key-up) and holds back key-downs for its long-press detection, so a release counts as the press here,
// like Vega's key-down.
import {useTVEventHandler as hook} from 'react-native';
export function useTVEventHandler(handle: (evt: {eventType: string; eventKeyAction?: number}) => void) {
  hook((e: any) => {
    if (e?.eventKeyAction === 0) return;
    handle({...e, eventKeyAction: 0});
  });
}
