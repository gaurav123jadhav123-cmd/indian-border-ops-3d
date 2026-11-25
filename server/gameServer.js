const http = require('http');
const { Server } = require('socket.io');
const { MatchRoom } = require('./rooms/MatchRoom');

const PORT = process.env.PORT || 5000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

const rooms = new Map();

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/ping') {
    const roomList = Array.from(rooms.values()).map((r) => ({
      roomId: r.roomId,
      mode: r.mode,
      humans: Array.from(r.players.values()).filter((p) => !p.isBot).length,
      total: r.players.size,
      avgTickMs: Number(r.avgTickMs.toFixed(2))
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'indian-border-ops-game-server',
      uptimeSec: Math.round(process.uptime()),
      rooms: roomList
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Indian Border Ops 3D Authoritative 5v5 PVP Server');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 5000
});

function getOrCreateRoom(roomId = 'border-sector-1', mode = 'TDM') {
  const safeId = String(roomId || 'border-sector-1').slice(0, 32);
  const safeMode = mode === 'FFA' ? 'FFA' : 'TDM';
  if (!rooms.has(safeId) || rooms.get(safeId).ended) {
    const room = new MatchRoom(safeId, safeMode, io, async (summary) => {
      try {
        await fetch(`${BACKEND_URL}/api/leaderboard/match`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(summary)
        });
      } catch (err) {
        console.warn('Could not report match summary to backend:', err.message);
      }
      setTimeout(() => rooms.delete(safeId), 5000);
    });
    rooms.set(safeId, room);
  }
  return rooms.get(safeId);
}

io.on('connection', (socket) => {
  let activeRoom = null;

  socket.on('join_match', (payload = {}) => {
    const { roomId = 'border-sector-1', mode = 'TDM', callsign, loadout, team } = payload;
    activeRoom = getOrCreateRoom(roomId, mode);
    const player = activeRoom.addPlayer(socket, { callsign, loadout, team });
    socket.emit('match_joined', {
      playerId: player.id,
      team: player.team,
      roomId: activeRoom.roomId,
      spawn: { x: player.x, y: player.y, z: player.z },
      player
    });
  });

  socket.on('player_move', (state) => {
    if (activeRoom) activeRoom.handleMove(socket.id, state);
  });

  socket.on('switch_weapon', (slot) => {
    if (activeRoom) activeRoom.handleSwitchWeapon(socket.id, slot);
  });

  socket.on('reload', () => {
    if (activeRoom) activeRoom.handleReload(socket.id);
  });

  socket.on('shoot', (data) => {
    if (activeRoom) activeRoom.handleShoot(socket.id, data);
  });

  socket.on('throw_grenade', (data) => {
    if (activeRoom) activeRoom.handleThrowGrenade(socket.id, data);
  });

  socket.on('call_missile', (data) => {
    if (activeRoom) activeRoom.handleCallMissile(socket.id, data);
  });

  socket.on('deploy_drone', (data = {}) => {
    if (activeRoom) activeRoom.handleDeployDrone(socket.id, data.mode);
  });

  socket.on('control_drone', (input) => {
    if (activeRoom) activeRoom.handleControlDrone(socket.id, input);
  });

  socket.on('use_heal', (data = {}) => {
    if (activeRoom) activeRoom.handleHeal(socket.id, data.item);
  });

  socket.on('loot_airdrop', (data = {}) => {
    if (activeRoom) activeRoom.handleLootAirdrop(socket.id, data.crateId);
  });

  socket.on('disconnect', () => {
    if (activeRoom) {
      activeRoom.removePlayer(socket.id);
      if (activeRoom.players.size === 0) {
        rooms.delete(activeRoom.roomId);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Game Server] Authoritative 5v5 PVP Socket.IO running on http://localhost:${PORT}`);
});
