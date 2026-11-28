// Connection to the game server (Socket.IO). It joins a match, forwards every server event to
// listeners, and - if the connection drops - reconnects and silently resumes the same soldier.
import { Emitter } from '../util.js';

const SOCKET_IO_URL = 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';
const JOIN_TIMEOUT_MS = 10000;

export class GameClient extends Emitter {
  /**
   * url        game server address
   * ioFactory  optional: the Socket.IO `io` function (tests pass a fake; the browser loads it from the CDN)
   */
  constructor({ url, ioFactory = null }) {
    super();
    this.url = url;
    this.ioFactory = ioFactory;
    this.socket = null;
    this.status = 'idle'; // idle | connecting | connected | reconnecting | closed
    this.joinParams = null;
    this.resumeKey = null;
    this.joined = false;
    this.pendingJoin = null;
    this.everConnected = false;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  async connect() {
    if (this.socket) return;
    this.setStatus('connecting');
    let io = this.ioFactory;
    if (!io) {
      try {
        io = (await import(SOCKET_IO_URL)).io;
      } catch {
        this.setStatus('closed');
        throw new Error('Could not load the networking library. Check your internet connection.');
      }
    }

    const socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
      timeout: 8000
    });
    this.socket = socket;

    socket.on('connect', () => {
      const first = !this.everConnected;
      this.everConnected = true;
      this.setStatus('connected');
      if (!first && this.joined && this.joinParams) this.sendJoin(); // resume after a dropped connection
    });
    socket.on('disconnect', (reason) => {
      if (this.status === 'closed') return;
      // "io client disconnect" = we asked for it; everything else the library retries on its own
      this.setStatus(reason === 'io client disconnect' ? 'closed' : 'reconnecting');
      if (this.status === 'reconnecting') this.emit('connection_lost', reason);
    });
    socket.on('connect_error', () => {
      if (!this.everConnected) {
        this.emit('connect_error');
      } else if (this.status !== 'closed') {
        this.setStatus('reconnecting');
      }
    });
    socket.onAny((event, payload) => this.handleServerEvent(event, payload));

    // wait for the first connection (or give up)
    await new Promise((resolve, reject) => {
      if (socket.connected) return resolve();
      const timer = setTimeout(() => {
        off();
        reject(new Error('Could not reach the game server. Is it running?'));
      }, 12000);
      const off = this.on('status', (s) => {
        if (s === 'connected') {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    }).catch((err) => {
      this.close();
      throw err;
    });
  }

  handleServerEvent(event, payload) {
    if (event === 'match_joined') {
      this.joined = true;
      this.resumeKey = payload?.resumeKey ?? this.resumeKey;
      if (this.pendingJoin) {
        clearTimeout(this.pendingJoin.timer);
        this.pendingJoin.resolve(payload);
        this.pendingJoin = null;
      }
    } else if (event === 'join_error') {
      if (this.pendingJoin) {
        clearTimeout(this.pendingJoin.timer);
        this.pendingJoin.reject(new Error(payload?.error || 'Could not join the match.'));
        this.pendingJoin = null;
      } else if (this.joined) {
        // a failed automatic re-join: the match is gone
        this.joined = false;
        this.emit('rejoin_failed', payload);
      }
    } else if (event === 'kicked') {
      this.close();
    }
    this.emit(event, payload);
  }

  sendJoin() {
    this.socket.emit('join_match', { ...this.joinParams, resumeKey: this.resumeKey ?? undefined });
  }

  /** Joins a match. Resolves with the server's `match_joined` payload. */
  join(params) {
    if (!this.socket?.connected) return Promise.reject(new Error('Not connected to the game server.'));
    this.joinParams = params;
    this.joined = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJoin = null;
        reject(new Error('The match did not answer. Please try again.'));
      }, JOIN_TIMEOUT_MS);
      this.pendingJoin = { resolve, reject, timer };
      this.sendJoin();
    });
  }

  /** Reliable message (shoot, reload, ...). Silently dropped while disconnected. */
  send(event, payload) {
    if (this.socket?.connected) this.socket.emit(event, payload);
  }

  /** Lossy message for things that are re-sent many times a second (movement, drone sticks). */
  sendFast(event, payload) {
    if (this.socket?.connected) (this.socket.volatile ?? this.socket).emit(event, payload);
  }

  leave() {
    if (this.socket?.connected && this.joined) this.socket.emit('leave_match');
    this.joined = false;
    this.joinParams = null;
    this.resumeKey = null;
  }

  close() {
    this.setStatus('closed');
    this.joined = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.disconnect();
      } catch { /* already closed */ }
    }
  }
}
