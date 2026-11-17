// A small HLS player for Vega. Vega's video player only takes HLS through Media Source Extensions: the app
// downloads the playlist and the segments and hands them over. The server sends one H.264 + stereo AAC rendition
// (server/app/player.py treats "firetv" like a browser), so there's no quality switching to do here.
//
// Segments are MPEG-TS (Plex, and Jellyfin's web profile) or fragmented MP4 (#EXT-X-MAP). MPEG-TS goes in as it is
// when the player takes it, otherwise mux.js rewraps it as MP4 first.
import {MediaSource, SourceBuffer, VideoPlayer} from '@amazon-devices/react-native-w3cmedia';
import {MediaPlaylist, parseMaster, parseMedia, Segment} from './m3u8';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const muxjs = require('mux.js');

/** GET as text or bytes. XMLHttpRequest because it can be cancelled and returns ArrayBuffers on every RN. */
function get(url: string, binary: boolean, jobs: Set<XMLHttpRequest>, timeout = 95000): Promise<any> {
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest();
    jobs.add(x);
    x.open('GET', url);
    if (binary) x.responseType = 'arraybuffer';
    x.timeout = timeout;
    x.onload = () => {
      jobs.delete(x);
      if (x.status >= 200 && x.status < 300) ok(binary ? x.response : x.responseText);
      else fail(new Error(`HTTP ${x.status}`));
    };
    x.onerror = () => {
      jobs.delete(x);
      fail(new Error('network'));
    };
    x.ontimeout = x.onerror;
    x.onabort = () => {
      jobs.delete(x);
      fail(new Error('aborted'));
    };
    x.send();
  });
}

const AHEAD = 40; // seconds buffered ahead of the playhead
const BEHIND = 20; // seconds kept behind it (for a quick jump back)
const DEFAULT_CODECS = 'avc1.640028,mp4a.40.2';

type Mode = 'ts' | 'mux' | 'mp4';

export class Hls {
  private video: VideoPlayer;
  private url: string;
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private mediaUrl = '';
  private list: MediaPlaylist = {segments: [], ended: false, target: 6};
  private codecs = DEFAULT_CODECS;
  private mode: Mode = 'ts';
  private next = 0; // the next segment to load
  private jobs = new Set<XMLHttpRequest>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private dead = false;
  private generation = 0; // bumps on every seek, so a download from before it is dropped
  private calibrate = true; // after a jump: line the next segment's own timestamps up with the playlist's
  private initSent = false;
  private transmuxer: any = null;
  private failures = 0;
  private lastReload = 0;
  onError: (message: string) => void = () => {};
  onLog: (message: string) => void = () => {};

  constructor(video: VideoPlayer, url: string) {
    this.video = video;
    this.url = url;
  }

  get duration(): number {
    const last = this.list.segments[this.list.segments.length - 1];
    return last ? last.start + last.duration : 0;
  }

  /** Loads the playlists and starts buffering at `at` (seconds). Resolves once the media is attached. */
  async start(at: number): Promise<void> {
    let text: string = await get(this.url, false, this.jobs, 30000);
    const master = parseMaster(text, this.url);
    this.mediaUrl = this.url;
    if (master) {
      this.mediaUrl = master.url;
      if (master.codecs) this.codecs = master.codecs;
      text = await get(this.mediaUrl, false, this.jobs, 30000);
    }
    this.list = parseMedia(text, this.mediaUrl);
    if (!this.list.segments.length) throw new Error('The stream is empty.');
    if (!(at > 0) && this.list.startAt) at = this.list.startAt;

    const ts = `video/mp2t; codecs="${this.codecs}"`;
    if (this.list.init) this.mode = 'mp4';
    else if (MediaSource.isTypeSupported(ts)) this.mode = 'ts';
    else this.mode = 'mux';
    this.onLog(`mode ${this.mode}, codecs ${this.codecs}, ${this.list.segments.length} segments, ended ${this.list.ended}`);

    const ms = new MediaSource();
    this.ms = ms;
    await new Promise<void>((ok) => {
      ms.addEventListener('sourceopen', () => ok());
      this.video.srcObject = ms as any;
    });
    if (this.dead) return;
    this.sb = ms.addSourceBuffer(this.mode === 'ts' ? ts : `video/mp4; codecs="${this.codecs}"`);
    if (this.list.ended) ms.duration = this.duration;
    if (this.mode === 'mux') this.makeTransmuxer();

    this.next = this.indexAt(at);
    this.video.currentTime = at;
    this.timer = setInterval(() => this.tick(), 400);
    this.tick();
  }

  private makeTransmuxer() {
    this.transmuxer = new muxjs.mp4.Transmuxer({keepOriginalTimestamps: true, remux: true});
  }

  private indexAt(t: number): number {
    const segs = this.list.segments;
    for (let i = 0; i < segs.length; i++) if (t < segs[i].start + segs[i].duration) return i;
    return Math.max(0, segs.length - 1);
  }

  private bufferedEnd(t: number): number {
    const b = this.sb?.buffered;
    if (!b) return t;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return b.end(i);
    return t;
  }

  /** Jump to `t`. Inside what's buffered it's instant; anywhere else the buffer starts again from there. */
  seek(t: number) {
    if (!this.sb || !this.ms) return;
    t = Math.max(0, Math.min(t, Math.max(0, this.duration - 1)));
    const end = this.bufferedEnd(t);
    if (end > t + 1) {
      this.video.currentTime = t;
      return;
    }
    this.generation++;
    for (const x of [...this.jobs]) x.abort();
    this.busy = false;
    this.calibrate = true;
    this.next = this.indexAt(t);
    if (this.transmuxer) this.makeTransmuxer();
    this.initSent = false;
    this.clearAll().then(() => {
      if (this.dead) return;
      this.video.currentTime = t;
      this.tick();
    });
  }

  private async clearAll() {
    const sb = this.sb!;
    try {
      if (sb.updating) sb.abort();
    } catch {}
    const b = sb.buffered;
    if (b && b.length) await this.op(() => sb.remove(0, b.end(b.length - 1) + 1));
  }

  /** Runs a SourceBuffer operation and waits for it to finish. */
  private op(f: () => void): Promise<void> {
    const sb = this.sb!;
    return new Promise((ok, fail) => {
      const done = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', bad);
        ok();
      };
      const bad = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', bad);
        fail(new Error('The player refused the video.'));
      };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', bad);
      try {
        f();
      } catch (e) {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', bad);
        fail(e);
      }
    });
  }

  private async tick() {
    if (this.dead || this.busy || !this.sb || !this.ms || this.sb.updating) return;
    const now = this.video.currentTime || 0;
    const segs = this.list.segments;
    if (this.next >= segs.length) {
      if (this.list.ended) {
        if (this.ms.readyState === 'open' && !this.sb.updating) {
          try {
            this.ms.endOfStream();
          } catch {}
        }
      } else if (Date.now() - this.lastReload > this.list.target * 1000) {
        this.lastReload = Date.now();
        this.reload();
      }
      return;
    }
    if (this.bufferedEnd(now) - now > AHEAD) {
      this.trim(now);
      return;
    }
    this.busy = true;
    const gen = this.generation;
    const seg = segs[this.next];
    try {
      if (this.mode === 'mp4' && !this.initSent && this.list.init) {
        const init = await get(this.list.init, true, this.jobs);
        if (gen !== this.generation) return;
        await this.op(() => this.sb!.appendBuffer(new Uint8Array(init)));
        this.initSent = true;
      }
      const bytes: ArrayBuffer = await get(seg.url, true, this.jobs);
      if (gen !== this.generation || this.dead) return;
      const data = this.mode === 'mux' ? this.transmux(new Uint8Array(bytes)) : new Uint8Array(bytes);
      if (data && data.byteLength) await this.append(data, seg, gen);
      if (gen !== this.generation) return;
      this.next++;
      this.failures = 0;
    } catch (e: any) {
      if (gen !== this.generation || this.dead) return;
      this.failures++;
      this.onLog(`segment ${this.next} failed: ${e?.message}`);
      if (this.failures >= 4) {
        this.dead = true;
        this.onError(e?.message === 'The player refused the video.' ? e.message : "The video stopped coming from the server.");
      }
    } finally {
      if (gen === this.generation) this.busy = false;
    }
  }

  /** Appends one segment. The first one after a jump is checked against where the playlist says it belongs, and
   *  moved there if its own timestamps start somewhere else (transcoders restart their clocks after a seek). */
  private async append(data: Uint8Array, seg: Segment, gen: number) {
    const sb = this.sb!;
    if (!this.calibrate) {
      await this.op(() => sb.appendBuffer(data));
      return;
    }
    const before = ranges(sb);
    await this.op(() => sb.appendBuffer(data));
    if (gen !== this.generation) return;
    const added = newStart(before, ranges(sb));
    this.calibrate = false;
    if (added == null) return;
    const shift = seg.start - added;
    this.onLog(`segment ${this.next} landed at ${added.toFixed(2)}, playlist says ${seg.start.toFixed(2)}`);
    if (Math.abs(shift) < 0.75) return;
    sb.timestampOffset = sb.timestampOffset + shift;
    await this.op(() => sb.remove(Math.max(0, added - 1), added + seg.duration + 2));
    await this.op(() => sb.appendBuffer(data)); // the same bytes again, now at the corrected offset
  }

  private transmux(bytes: Uint8Array): Uint8Array | null {
    let out: Uint8Array | null = null;
    const t = this.transmuxer;
    const onData = (segment: any) => {
      const init: Uint8Array = this.initSent ? new Uint8Array(0) : segment.initSegment;
      const body: Uint8Array = segment.data;
      const all = new Uint8Array(init.byteLength + body.byteLength);
      all.set(init, 0);
      all.set(body, init.byteLength);
      out = all;
      this.initSent = true;
    };
    t.on('data', onData);
    t.push(bytes);
    t.flush();
    t.off('data', onData);
    return out;
  }

  private trim(now: number) {
    const sb = this.sb!;
    const b = sb.buffered;
    if (!b || !b.length || sb.updating) return;
    if (now - b.start(0) > BEHIND + 10) {
      this.busy = true;
      this.op(() => sb.remove(0, now - BEHIND))
        .catch(() => {})
        .finally(() => (this.busy = false));
    }
  }

  private async reload() {
    try {
      const text = await get(this.mediaUrl, false, this.jobs, 30000);
      const fresh = parseMedia(text, this.mediaUrl);
      if (fresh.segments.length > this.list.segments.length) {
        this.list = fresh;
        if (fresh.ended && this.ms) this.ms.duration = this.duration;
      } else if (fresh.ended) this.list.ended = true;
    } catch {}
  }

  destroy() {
    this.dead = true;
    if (this.timer) clearInterval(this.timer);
    for (const x of [...this.jobs]) x.abort();
  }
}

function ranges(sb: SourceBuffer): [number, number][] {
  const out: [number, number][] = [];
  const b = sb.buffered;
  if (b) for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
  return out;
}

/** Where the newly added media starts: a new range, or an existing one that grew at its start. */
function newStart(before: [number, number][], after: [number, number][]): number | null {
  for (const [s, e] of after) {
    const old = before.find(([bs, be]) => bs <= e && be >= s);
    if (!old) return s;
    if (s < old[0] - 0.1) return s;
  }
  // grew at an end: the segment followed straight on from what was there
  return null;
}
