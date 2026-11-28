import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../../js/net/api.js';

/** A fetch that records the request and answers with `reply`. */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === 'function' ? reply(url, init) : reply;
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('guest, register and login send JSON to the right address (trailing slashes tolerated)', async () => {
  const f = fakeFetch(json(200, { token: 't' }));
  const api = createApi({ baseUrl: 'http://host:4000///', fetchFn: f });

  assert.deepEqual(await api.guest('Veer_1'), { token: 't' });
  assert.equal(f.calls[0].url, 'http://host:4000/api/auth/guest');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { callsign: 'Veer_1' });

  await api.register('Veer_1', 'secret1');
  assert.equal(f.calls[1].url, 'http://host:4000/api/auth/register');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { callsign: 'Veer_1', password: 'secret1' });

  await api.login('Veer_1', 'secret1');
  assert.equal(f.calls[2].url, 'http://host:4000/api/auth/login');
});

test('requests that need a login send the token; others do not', async () => {
  const f = fakeFetch(json(200, {}));
  const api = createApi({ baseUrl: 'http://h', fetchFn: f });
  await api.me('tok123');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok123');
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal('Content-Type' in f.calls[0].init.headers, false);

  await api.arsenal();
  assert.equal(f.calls[1].url, 'http://h/api/arsenal');
  assert.equal('Authorization' in f.calls[1].init.headers, false);

  await api.leaderboard();
  assert.equal(f.calls[2].url, 'http://h/api/leaderboard');

  await api.saveLoadout('tok123', { primary: 'ak203' });
  assert.equal(f.calls[3].url, 'http://h/api/loadout/save');
  assert.equal(f.calls[3].init.headers.Authorization, 'Bearer tok123');
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { primary: 'ak203' });
});

test('the server error message reaches the caller with its status', async () => {
  const api = createApi({ baseUrl: 'http://h', fetchFn: fakeFetch(json(401, { error: 'Wrong callsign or password.' })) });
  await assert.rejects(() => api.login('a', 'b'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, 'Wrong callsign or password.');
    assert.equal(err.status, 401);
    return true;
  });
});

test('an error without a JSON body still gives a readable message', async () => {
  const f = fakeFetch({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  const api = createApi({ baseUrl: 'http://h', fetchFn: f });
  await assert.rejects(() => api.arsenal(), (err) => err instanceof ApiError && /502/.test(err.message) && err.status === 502);
});

test('a success without a JSON body gives an empty object', async () => {
  const f = fakeFetch({ ok: true, status: 204, json: async () => { throw new Error('empty'); } });
  const api = createApi({ baseUrl: 'http://h', fetchFn: f });
  assert.deepEqual(await api.arsenal(), {});
});

test('network failure: a friendly message, status 0', async () => {
  const api = createApi({ baseUrl: 'http://h', fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => api.arsenal(), (err) => err instanceof ApiError && err.status === 0 && /Cannot reach the server/.test(err.message));
});

test('a slow server is given up on after the timeout', async () => {
  const slow = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const api = createApi({ baseUrl: 'http://h', fetchFn: slow, timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(() => api.arsenal(), (err) => err instanceof ApiError && /too long/.test(err.message));
  assert.ok(Date.now() - started < 1500);
});
