// NuniFlix for Android-based Fire TVs (Fire OS): the same app as the Vega one, from ../src.
import {AppRegistry, LogBox} from 'react-native';
import {App} from '../src/App';
import {name as appName} from './app.json';

LogBox.ignoreAllLogs();
AppRegistry.registerComponent(appName, () => App);
