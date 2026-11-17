import {api} from '../src/api';
import {DEMO} from '../src/demo';

beforeEach(() => {
  api.base = DEMO;
  api.token = 'demo';
});

test('the demo answers without a server', async () => {
  expect(await api.check(DEMO)).toBe(true);
  const rows = await api.get<{rows: {items: unknown[]}[]}>('/browse/provider/0/rows', {type: 'all'});
  expect(rows.rows[0].items.length).toBeGreaterThan(3);
  const start = JSON.parse((await api.post('/play/start', {id: 'bbb'}))[0]);
  expect(start.url).toMatch(/^https:\/\//);
});

test('requesting in the demo marks it requested', async () => {
  await api.post('/requests', {type: 'movie', id: 45745});
  const it = await api.get<{status: string}>('/item/movie/45745');
  expect(it.status).toBe('pending');
  const mine = await api.get<{requests: unknown[]}>('/requests', {scope: 'mine'});
  expect(mine.requests.length).toBe(1);
});

test('unknown calls fail like the server would', async () => {
  await expect(api.get('/nope')).rejects.toThrow('Not in the demo.');
});
