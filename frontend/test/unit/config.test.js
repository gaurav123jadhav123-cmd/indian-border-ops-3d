import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, resolveConfig } from '../../js/config.js';

/** A fake `window.location` built from a URL. */
function loc(url) {
  const u = new URL(url);
  return { search: u.search, protocol: u.protocol, hostname: u.hostname, port: u.port, origin: u.origin };
}

test('isPrivateHost: own machine and home networks are private', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.255.255', 'my-phone.local', '[::1]']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('isPrivateHost: public addresses are not private', () => {
  for (const h of ['', 'example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '11.0.0.1']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('local play: backend on port 4000 and game server on port 5000 of the same machine', () => {
  const cfg = resolveConfig({ location: loc('http://192.168.1.20:8080/'), env: {} });
  assert.equal(cfg.api, 'http://192.168.1.20:4000');
  assert.equal(cfg.server, 'http://192.168.1.20:5000');
  assert.equal(cfg.room, null);
  assert.equal(cfg.debug, false);
});

test('page served by the backend itself (port 4000): the API is the page origin', () => {
  const cfg = resolveConfig({ location: loc('http://localhost:4000/'), env: {} });
  assert.equal(cfg.api, 'http://localhost:4000');
  assert.equal(cfg.server, 'http://localhost:5000');
});

test('?api= and ?server= work on a private address and lose their trailing slash', () => {
  const cfg = resolveConfig({ location: loc('http://192.168.1.9:4000/?api=http://192.168.1.30:4000/&server=http://192.168.1.30:5000//'), env: {} });
  assert.equal(cfg.api, 'http://192.168.1.30:4000');
  assert.equal(cfg.server, 'http://192.168.1.30:5000');
});

test('?api= and ?server= are ignored on a public address (a crafted link cannot redirect a login)', () => {
  const cfg = resolveConfig({ location: loc('https://play.example.com/?api=https://evil.example&server=https://evil.example'), env: {} });
  assert.equal(cfg.api, 'https://play.example.com');
  assert.equal(cfg.server, 'https://play.example.com');
});

test('env.js values are used and cleaned up on a public address', () => {
  const cfg = resolveConfig({
    location: loc('https://play.example.com/'),
    env: { API_URL: ' https://api.example.com/ ', GAME_SERVER_URL: 'https://game.example.com' }
  });
  assert.equal(cfg.api, 'https://api.example.com');
  assert.equal(cfg.server, 'https://game.example.com');
});

test('on a private address the address bar wins over env.js', () => {
  const cfg = resolveConfig({
    location: loc('http://localhost:8080/?api=http://localhost:4100'),
    env: { API_URL: 'https://api.example.com', GAME_SERVER_URL: 'https://game.example.com' }
  });
  assert.equal(cfg.api, 'http://localhost:4100');
  assert.equal(cfg.server, 'https://game.example.com');
});

test('room code: only letters, digits, _ and - up to 24 characters', () => {
  const ok = (q) => resolveConfig({ location: loc(`http://localhost:8080/${q}`), env: {} }).room;
  assert.equal(ok('?room=alpha_1'), 'alpha_1');
  assert.equal(ok('?room=A-B'), 'A-B');
  assert.equal(ok('?room=' + 'x'.repeat(24)), 'x'.repeat(24));
  assert.equal(ok('?room=' + 'x'.repeat(25)), null);
  assert.equal(ok('?room=bad%20room'), null);
  assert.equal(ok('?room=%3Cscript%3E'), null);
  assert.equal(ok('?room='), null);
  assert.equal(ok(''), null);
});

test('?debug switches debug mode on', () => {
  assert.equal(resolveConfig({ location: loc('http://localhost:8080/?debug'), env: {} }).debug, true);
  assert.equal(resolveConfig({ location: loc('http://localhost:8080/?debug=1'), env: {} }).debug, true);
  assert.equal(resolveConfig({ location: loc('http://localhost:8080/?x=1'), env: {} }).debug, false);
});
