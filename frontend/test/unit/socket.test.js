import test from 'node:test';
import assert from 'node:assert/strict';
import { GameClient } from '../../js/net/socket.js';

/** A pretend Socket.IO `io`. The test plays the server through the controls on each socket. */
function makeFakeIo() {
  const sockets = [];
  const io = (url, opts) => {
    const handlers = new Map();
    const any = [];
    const sock = {
      url,
      opts,
      connected: false,
      sent: [],
      fast: [],
      disconnectCalls: 0,
      on(ev, fn) { handlers.set(ev, fn); },
      onAny(fn) { any.push(fn); },
      emit(ev, payload) { sock.sent.push([ev, payload]); },
      volatile: { emit(ev, payload) { sock.fast.push([ev, payload]); } },
      disconnect() {
        sock.disconnectCalls += 1;
        if (sock.connected) {
          sock.connected = false;
          handlers.get('disconnect')?.('io client disconnect');
        }
      },
      // --- what the "server side" can do
      serverConnect() { sock.connected = true; handlers.get('connect')?.(); },
      serverDrop(reason = 'transport close') { sock.connected = false; handlers.get('disconnect')?.(reason); },
      serverSend(ev, payload) { for (const fn of any) fn(ev, payload); },
      connectError() { handlers.get('connect_error')?.(new Error('refused')); }
    };
    sockets.push(sock);
    return sock;
  };
  return { io, sockets };
}

async function connected(extra = {}) {
  const { io, sockets } = makeFakeIo();
  const client = new GameClient({ url: 'http://game:5000', ioFactory: io, ...extra });
  const p = client.connect();
  sockets[0].serverConnect();
  await p;
  return { client, sock: sockets[0], sockets };
}

const JOIN = { token: 'tok', roomId: 'alpha', mode: 'TDM', loadout: { primary: 'sig716' } };
const JOINED = { playerId: 'p1', resumeKey: 'abcdef0123456789', team: 'bharat' };

test('connect: uses the given address, tries websocket first, and reports its status', async () => {
  const { io, sockets } = makeFakeIo();
  const client = new GameClient({ url: 'http://game:5000', ioFactory: io });
  const statuses = [];
  client.on('status', (s) => statuses.push(s));
  assert.equal(client.status, 'idle');
  const p = client.connect();
  assert.equal(client.status, 'connecting');
  assert.equal(sockets[0].url, 'http://game:5000');
  assert.deepEqual(sockets[0].opts.transports, ['websocket', 'polling']);
  assert.equal(sockets[0].opts.reconnection, true);
  sockets[0].serverConnect();
  await p;
  assert.equal(client.status, 'connected');
  assert.deepEqual(statuses, ['connecting', 'connected']);
  // connecting twice does nothing
  await client.connect();
  assert.equal(sockets.length, 1);
});

test('join: sends join_match and resolves with the server answer; the resume key is remembered', async () => {
  const { client, sock } = await connected();
  const p = client.join(JOIN);
  assert.deepEqual(sock.sent[0], ['join_match', { ...JOIN, resumeKey: undefined }]);
  sock.serverSend('match_joined', JOINED);
  assert.deepEqual(await p, JOINED);
  assert.equal(client.joined, true);
  assert.equal(client.resumeKey, 'abcdef0123456789');
});

test('join: the server can refuse, and the message is passed on', async () => {
  const { client, sock } = await connected();
  const p = client.join(JOIN);
  sock.serverSend('join_error', { error: 'Room is full.' });
  await assert.rejects(() => p, /Room is full\./);
  assert.equal(client.joined, false);
  const p2 = client.join(JOIN);
  sock.serverSend('join_error', {});
  await assert.rejects(() => p2, /Could not join the match\./);
});

test('join before the connection is up fails clearly', async () => {
  const client = new GameClient({ url: 'http://x', ioFactory: makeFakeIo().io });
  await assert.rejects(() => client.join(JOIN), /Not connected/);
});

test('every server event is passed on to listeners', async () => {
  const { client, sock } = await connected();
  const got = [];
  client.on('state_snapshot', (p) => got.push(p));
  client.on('kill_feed', (p) => got.push(p));
  sock.serverSend('state_snapshot', { seq: 1 });
  sock.serverSend('kill_feed', { killer: 'A' });
  sock.serverSend('something_new', { x: 1 }); // nobody listens: must not fail
  assert.deepEqual(got, [{ seq: 1 }, { killer: 'A' }]);
});

test('a dropped connection is reported, then the same soldier is claimed again with the resume key', async () => {
  const { client, sock } = await connected();
  const p = client.join(JOIN);
  sock.serverSend('match_joined', JOINED);
  await p;

  const events = [];
  client.on('status', (s) => events.push(`status:${s}`));
  client.on('connection_lost', (r) => events.push(`lost:${r}`));

  sock.serverDrop('transport close');
  assert.equal(client.status, 'reconnecting');
  assert.deepEqual(events, ['status:reconnecting', 'lost:transport close']);

  // nothing is sent while the line is down
  client.send('shoot', { dir: { x: 0, y: 0, z: -1 } });
  client.sendFast('player_move', {});
  assert.equal(sock.sent.length, 1); // only the original join
  assert.equal(sock.fast.length, 0);

  sock.serverConnect(); // the library reconnected on its own
  assert.equal(client.status, 'connected');
  const rejoin = sock.sent.filter(([ev]) => ev === 'join_match');
  assert.equal(rejoin.length, 2);
  assert.deepEqual(rejoin[1][1], { ...JOIN, resumeKey: 'abcdef0123456789' });
});

test('if the automatic re-join is refused the match is gone: rejoin_failed', async () => {
  const { client, sock } = await connected();
  const p = client.join(JOIN);
  sock.serverSend('match_joined', JOINED);
  await p;
  sock.serverDrop();
  sock.serverConnect();
  const failed = [];
  client.on('rejoin_failed', (e) => failed.push(e));
  sock.serverSend('join_error', { error: 'Match ended.' });
  assert.deepEqual(failed, [{ error: 'Match ended.' }]);
  assert.equal(client.joined, false);
});

test('closing on purpose is not reported as a lost connection', async () => {
  const { client, sock } = await connected();
  let lost = 0;
  client.on('connection_lost', () => { lost += 1; });
  client.close();
  assert.equal(client.status, 'closed');
  assert.equal(sock.disconnectCalls, 1);
  assert.equal(lost, 0);
  assert.equal(client.socket, null);
});

test('kicked: the client closes itself and still tells listeners why', async () => {
  const { client, sock } = await connected();
  const kicks = [];
  client.on('kicked', (p) => kicks.push(p));
  sock.serverSend('kicked', { reason: 'Signed in on another device.' });
  assert.equal(client.status, 'closed');
  assert.equal(sock.disconnectCalls, 1);
  assert.deepEqual(kicks, [{ reason: 'Signed in on another device.' }]);
  // the late "io server disconnect" must not look like a dropped line
  let lost = 0;
  client.on('connection_lost', () => { lost += 1; });
  sock.serverDrop('io server disconnect');
  assert.equal(lost, 0);
});

test('send is reliable, sendFast is lossy (volatile) and both are dropped while offline', async () => {
  const { client, sock } = await connected();
  client.send('reload');
  client.send('switch_weapon', { slot: 'secondary' });
  client.sendFast('player_move', { x: 1 });
  assert.deepEqual(sock.sent, [['reload', undefined], ['switch_weapon', { slot: 'secondary' }]]);
  assert.deepEqual(sock.fast, [['player_move', { x: 1 }]]);
  sock.connected = false;
  client.send('reload');
  client.sendFast('player_move', { x: 2 });
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.fast.length, 1);
});

test('leave: tells the server once and forgets the match', async () => {
  const { client, sock } = await connected();
  client.leave(); // not joined yet: nothing to say
  assert.equal(sock.sent.length, 0);
  const p = client.join(JOIN);
  sock.serverSend('match_joined', JOINED);
  await p;
  client.leave();
  assert.deepEqual(sock.sent.at(-1), ['leave_match', undefined]);
  assert.equal(client.joined, false);
  assert.equal(client.joinParams, null);
  assert.equal(client.resumeKey, null);
  // after leaving, a reconnect must not try to re-join
  sock.serverDrop();
  sock.serverConnect();
  assert.equal(sock.sent.filter(([ev]) => ev === 'join_match').length, 1);
});

test('a connect error before the first connection is reported without changing the status', async () => {
  const { io, sockets } = makeFakeIo();
  const client = new GameClient({ url: 'http://x', ioFactory: io });
  const errors = [];
  client.on('connect_error', () => errors.push(1));
  const p = client.connect();
  sockets[0].connectError();
  assert.deepEqual(errors, [1]);
  assert.equal(client.status, 'connecting');
  sockets[0].serverConnect();
  await p;
  // an error after a good connection means the line is down and being retried
  sockets[0].connectError();
  assert.equal(client.status, 'reconnecting');
});
