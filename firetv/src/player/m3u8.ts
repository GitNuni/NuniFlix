// Reading HLS playlists: just what the NuniFlix server's streams use.

export interface Segment {
  url: string;
  start: number;
  duration: number;
}

export interface MediaPlaylist {
  segments: Segment[];
  init?: string; // #EXT-X-MAP: fragmented MP4
  ended: boolean; // #EXT-X-ENDLIST: the whole title is listed
  target: number;
  startAt?: number; // #EXT-X-START
}

export function resolve(base: string, ref: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  const origin = base.match(/^https?:\/\/[^/]+/i)![0];
  if (ref.startsWith('/')) return origin + ref;
  const dir = base.split('?')[0].replace(/[^/]*$/, '');
  return dir + ref;
}

function attr(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(`${name}=("([^"]*)"|[^,]*)`));
  return m ? m[2] ?? m[1] : undefined;
}

/** A master playlist's first rendition (url, codecs), or null if this already is a media playlist. */
export function parseMaster(text: string, base: string): {url: string; codecs?: string} | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const codecs = attr(lines[i], 'CODECS');
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l && !l.startsWith('#')) return {url: resolve(base, l), codecs};
      }
    }
  }
  return null;
}

export function parseMedia(text: string, base: string): MediaPlaylist {
  const out: MediaPlaylist = {segments: [], ended: false, target: 6};
  let t = 0;
  let dur = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) out.target = parseFloat(l.slice(22)) || 6;
    else if (l.startsWith('#EXT-X-ENDLIST')) out.ended = true;
    else if (l.startsWith('#EXT-X-MAP')) {
      const u = attr(l, 'URI');
      if (u) out.init = resolve(base, u);
    } else if (l.startsWith('#EXT-X-START')) {
      const o = parseFloat(attr(l, 'TIME-OFFSET') ?? '');
      if (isFinite(o)) out.startAt = o;
    } else if (!l.startsWith('#')) {
      out.segments.push({url: resolve(base, l), start: t, duration: dur});
      t += dur;
      dur = 0;
    }
  }
  return out;
}
