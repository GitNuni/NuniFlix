// The app's code lives in ../src (shared with the Vega app). Everything it imports must come from *this*
// folder's node_modules (react-native-tvos), never from ../node_modules (Vega's React Native).
const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const here = __dirname;
const shared = path.resolve(here, '../src');

module.exports = mergeConfig(getDefaultConfig(here), {
  watchFolders: [shared],
  resolver: {
    nodeModulesPaths: [path.resolve(here, 'node_modules')],
    disableHierarchicalLookup: true,
  },
});
