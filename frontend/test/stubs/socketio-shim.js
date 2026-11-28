// Stand-in for the Socket.IO browser client, used ONLY by the offline browser tests.
// It talks to a test harness through three functions the harness exposes on `window`
// (__srvConnect, __srvEmit, __srvDisconnect); the harness runs the REAL game-server code.
export function io(url, opts) {
  const handlers = new Map();
  const any = [];
  const fire = (ev, ...args) => (handlers.get(ev) ?? []).forEach((fn) => fn(...args));

  const sock = {
    connected: false,
    id: null,
    cid: null,
    opts,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
      return sock;
    },
    onAny(fn) {
      any.push(fn);
      return sock;
    },
    emit(ev, payload) {
      if (sock.connected) window.__srvEmit(sock.cid, ev, payload);
      return sock;
    },
    get volatile() {
      return { emit: (ev, payload) => sock.emit(ev, payload) };
    },
    disconnect() {
      if (!sock.connected) return sock;
      sock.connected = false;
      window.__srvDisconnect(sock.cid);
      fire('disconnect', 'io client disconnect');
      return sock;
    },

    // ---- hooks for the tests
    __deliver(ev, payload) {
      if (ev === '__disconnect') return sock.__drop(payload);
      fire(ev, payload);
      any.forEach((fn) => fn(ev, payload));
    },
    __drop(reason = 'transport close') {
      if (!sock.connected) return;
      sock.connected = false;
      window.__srvDisconnect(sock.cid);
      fire('disconnect', reason);
    },
    async __reconnect() {
      sock.cid = await window.__srvConnect();
      sock.connected = true;
      fire('connect');
    }
  };

  (window.__sockets ??= []).push(sock);
  if (!window.__deliver) {
    window.__deliver = (cid, ev, payload) => {
      for (const s of window.__sockets) if (s.cid === cid) s.__deliver(ev, payload);
    };
  }
  setTimeout(() => sock.__reconnect(), 0);
  return sock;
}
