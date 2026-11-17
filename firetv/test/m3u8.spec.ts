import {parseMaster, parseMedia, resolve} from '../src/player/m3u8';

const base = 'https://flix.example.com/api/stream/abc/video/:/transcode/universal/start.m3u8?x=1';

test('resolves relative, absolute and rooted references', () => {
  expect(resolve(base, 'session/s1/base/index.m3u8')).toBe('https://flix.example.com/api/stream/abc/video/:/transcode/universal/session/s1/base/index.m3u8');
  expect(resolve(base, '/api/stream/abc/x.ts')).toBe('https://flix.example.com/api/stream/abc/x.ts');
  expect(resolve(base, 'https://other/x.ts')).toBe('https://other/x.ts');
});

test('master playlist: first rendition and its codecs', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\nsession/s1/base/index.m3u8\n';
  expect(parseMaster(text, base)).toEqual({
    url: 'https://flix.example.com/api/stream/abc/video/:/transcode/universal/session/s1/base/index.m3u8',
    codecs: 'avc1.640028,mp4a.40.2',
  });
  expect(parseMaster('#EXTM3U\n#EXTINF:5,\na.ts\n', base)).toBeNull();
});

test('media playlist: segment times, start offset, end', () => {
  const text = '#EXTM3U\n#EXT-X-START:TIME-OFFSET=12.50\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n0.ts\n#EXTINF:6.0,\n1.ts\n#EXTINF:3.5,\n2.ts\n#EXT-X-ENDLIST\n';
  const m = parseMedia(text, base);
  expect(m.segments.map((x) => x.start)).toEqual([0, 6, 12]);
  expect(m.segments[2].duration).toBe(3.5);
  expect(m.startAt).toBe(12.5);
  expect(m.ended).toBe(true);
  expect(m.init).toBeUndefined();
});

test('fragmented MP4 playlists carry an init segment', () => {
  const m = parseMedia('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n0.m4s\n', base);
  expect(m.init).toMatch(/\/init\.mp4$/);
  expect(m.ended).toBe(false);
});
