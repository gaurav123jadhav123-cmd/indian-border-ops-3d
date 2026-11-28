// Connects one Socket.IO socket to the game. It knows nothing about Socket.IO internals beyond
// socket.on / socket.emit / socket.volatile.emit / socket.disconnect, so tests use a fake socket.
//
// Every incoming event goes through the same gate: rate limit -> payload validation ->
// "is this still the connection that owns the player?" -> room logic, all inside try/catch so
// one hostile or malformed packet can never crash the process.
import { performance } from 'node:perf_hooks';
import { verifyToken } from '../shared/token.js';
import { RateLimiter, SOCKET_LIMITS } from './rateLimit.js';
import {
  sanitizeJoin, sanitizeMove, sanitizeSlot, sanitizeShoot, sanitizeThrow, sanitizeMissile,
  sanitizeDeploy, sanitizeDroneInput, sanitizeDroneAction, sanitizeHeal, sanitizeLoot
} from './validate.js';

const silent = { info() {}, warn() {}, error() {} };

export function attachSocket(socket, { manager, secret, clock = () => performance.now(), log = silent }) {
  const limiter = new RateLimiter(SOCKET_LIMITS, clock);
  const ctx = { room: null, player: null };

  const conn = {
    id: socket.id,
    send(event, payload, opts) {
      (opts?.volatile ? socket.volatile : socket).emit(event, payload);
    },
    disconnect() {
      socket.disconnect(true);
    }
  };

  /** Register a game event with validation + ownership check. `sanitize` may be null. */
  function on(event, sanitize, run) {
    socket.on(event, (raw) => {
      try {
        if (!limiter.allow(event)) return;
        let data;
        if (sanitize) {
          data = sanitize(raw);
          if (data === null) return; // garbage payload: ignore silently
        }
        if (!ctx.room || !ctx.player || ctx.player.conn !== conn) return; // not joined / replaced
        run(ctx.room, ctx.player, data, clock());
      } catch (err) {
        log.error(`handler "${event}" failed`, err);
      }
    });
  }

  socket.on('join_match', (raw, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const fail = (error) => {
      conn.send('join_error', { error });
      reply({ ok: false, error });
    };
    try {
      if (!limiter.allow('join_match')) return fail('Too many join attempts. Please wait a moment.');
      const req = sanitizeJoin(raw);
      if (!req) return fail('Invalid join request.');

      const claims = verifyToken(req.token, secret);
      if (!claims || claims.role === 'server' || typeof claims.sub !== 'string' || !claims.sub) {
        return fail('Your session expired. Please sign in again.');
      }

      // Joining a different match on the same socket first leaves the previous one.
      if (ctx.room && ctx.player) {
        ctx.room.leave(ctx.player, conn);
        ctx.room = null;
        ctx.player = null;
      }

      const acquired = manager.acquire(req.roomId, req.mode);
      if (acquired.error) return fail(acquired.error);

      const identity = {
        id: claims.sub,
        name: typeof claims.name === 'string' ? claims.name : '',
        userId: claims.guest ? null : claims.sub,
        guest: !!claims.guest
      };
      const result = acquired.room.join(conn, identity, { loadout: req.loadout, resumeKey: req.resumeKey });
      if (!result.ok) return fail(result.error);

      ctx.room = acquired.room;
      ctx.player = result.player;
      conn.send('match_joined', ctx.room.joinPayload(result.player, result.resumed));
      reply({ ok: true });
    } catch (err) {
      log.error('join_match failed', err);
      fail('Could not join the match.');
    }
  });

  on('player_move', sanitizeMove, (room, p, d, now) => room.handleMove(p, d, now));
  on('switch_weapon', sanitizeSlot, (room, p, slot, now) => room.handleSwitch(p, slot, now));
  on('reload', null, (room, p, _d, now) => room.handleReload(p, now));
  on('shoot', sanitizeShoot, (room, p, d, now) => room.handleShoot(p, d, now));
  on('throw_grenade', sanitizeThrow, (room, p, d, now) => room.handleThrow(p, d, now));
  on('call_missile', sanitizeMissile, (room, p, d, now) => room.handleMissile(p, d, now));
  on('deploy_drone', sanitizeDeploy, (room, p, d, now) => room.handleDeploy(p, d, now));
  on('control_drone', sanitizeDroneInput, (room, p, d, now) => room.handleDroneInput(p, d, now));
  on('drone_action', sanitizeDroneAction, (room, p, d) => room.handleDroneAction(p, d));
  on('use_heal', sanitizeHeal, (room, p, d, now) => room.handleHeal(p, d, now));
  on('cancel_heal', null, (room, p) => room.handleCancelHeal(p));
  on('loot_airdrop', sanitizeLoot, (room, p, d, now) => room.handleLoot(p, d, now));

  on('leave_match', null, (room, p) => {
    room.leave(p, conn);
    ctx.room = null;
    ctx.player = null;
  });

  socket.on('disconnect', () => {
    try {
      if (ctx.room && ctx.player) ctx.room.detach(ctx.player, conn);
    } catch (err) {
      log.error('disconnect handler failed', err);
    }
  });
}
