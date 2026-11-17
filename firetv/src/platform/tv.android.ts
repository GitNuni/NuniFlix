// Remote buttons on Android TV / Fire OS: react-native-tvos has the same hook.
import {useTVEventHandler as hook} from 'react-native';
export function useTVEventHandler(handle: (evt: {eventType: string; eventKeyAction?: number}) => void) {
  hook((e: any) => handle(e));
}
