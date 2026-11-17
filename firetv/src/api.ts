// Talks to the NuniFlix server with `Authorization: Bearer <token>`, like apple/Sources/Core/API.swift.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Plain http only for addresses inside the home (or a VPN). Anything out on the internet must be https,
 *  so a sign-in token never crosses the internet unencrypted. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // Tailscale / CGNAT
  );
}

/** "192.168.0.49:8095" -> "http://192.168.0.49:8095"; checks the http/https rule above. */
export function normalizeServer(input: string): string {
  let s = input.trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (!s.includes('://')) s = 'http://' + s;
  const m = s.match(/^(https?):\/\/([^/:?#]+)(:\d+)?(\/[^?#]*)?$/i);
  if (!m) throw new ApiError(0, "That doesn't look like an address.");
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  if (scheme === 'http' && !isPrivateHost(host)) {
    throw new ApiError(0, 'Outside your home network, use your https address (for example https://requests.example.com).');
  }
  return scheme + '://' + host + (m[3] ?? '') + (m[4] ?? '');
}

type Query = Record<string, string | undefined>;

class Api {
  base: string | null = null;
  token: string | null = null;
  /** Called when the server says the session is gone (signed out elsewhere, or 90 days unused). */
  onUnauthorized: (() => void) | null = null;

  url(path: string, query: Query = {}): string {
    if (!this.base) throw new ApiError(0, 'No server set.');
    const encoded = path.replace(/\|/g, '%7C');
    const q = Object.keys(query)
      .filter((k) => query[k] !== undefined)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] as string)}`)
      .join('&');
    return `${this.base}/api${encoded}${q ? '?' + q : ''}`;
  }

  /** Raw call: [body text, status]. Throws ApiError for status >= 400, with the server's own message. */
  async send(method: string, path: string, query: Query = {}, body?: object, signal?: AbortSignal): Promise<[string, number]> {
    const headers: Record<string, string> = {Accept: 'application/json'};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    signal?.addEventListener('abort', () => ctrl.abort());
    let res: Response;
    try {
      res = await fetch(this.url(path, query), {method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal});
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (signal?.aborted) throw new ApiError(-1, 'Cancelled.');
      throw new ApiError(0, "Can't reach the server. Check that it's on and the address is right.");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status >= 400) {
      if (res.status === 401 && this.token) this.onUnauthorized?.();
      throw new ApiError(res.status, Api.detail(text) ?? `Something went wrong (${res.status}).`);
    }
    return [text, res.status];
  }

  async get<T>(path: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
    const [text] = await this.send('GET', path, query, undefined, signal);
    return Api.decode<T>(text);
  }

  post(path: string, body: object = {}): Promise<[string, number]> {
    return this.send('POST', path, {}, body);
  }

  static decode<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(0, 'The server sent something unexpected. Is NuniFlix up to date?');
    }
  }

  private static detail(text: string): string | null {
    try {
      const obj = JSON.parse(text);
      if (typeof obj.detail === 'string') return obj.detail;
      if (Array.isArray(obj.detail) && obj.detail[0]?.msg) return obj.detail[0].msg;
    } catch {}
    return null;
  }

  /** Is there a NuniFlix at this address? */
  async check(candidate: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(candidate + '/api/health', {signal: ctrl.signal});
      if (r.status !== 200) return false;
      const obj = await r.json();
      return obj.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const api = new Api();

export function errorText(e: unknown): string | null {
  if (e instanceof ApiError) return e.status === -1 ? null : e.message;
  return e instanceof Error ? e.message : String(e);
}
