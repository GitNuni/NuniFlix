const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * Debug builds can POST a line to /nf-log (see src/log.ts); it's printed here, in Metro's own output.
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  server: {
    enhanceMiddleware: (middleware) => (req, res, next) => {
      if (req.url === '/nf-log' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          console.log('[TV] ' + body.slice(0, 2000));
          res.end('ok');
        });
        return;
      }
      return middleware(req, res, next);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
