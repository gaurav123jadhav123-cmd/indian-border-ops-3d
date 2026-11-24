const http = require('http');
const { Server } = require('socket.io');
const { MatchRoom } = require('./rooms/MatchRoom');

const PORT = process.env.PORT || 5000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'indian-border-ops-game-server', rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Indian Border Ops 3D Authoritative PVP Server');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = new Map();

function getOrCreateRoom(roomId = 'border-sector-1', mode = 'TDM') {
  if (!rooms.has(roomId) || rooms.get(roomId).ended) {
    const room = new MatchRoom(roomId, mode, io, async (summary) => {
      try {
        await fetch(`${BACKEND_URL}/api/leaderboard/match`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(summary)
        });
      } catch (err) {
        console.warn('Could not report match summary to backend:', err.message);
      }
    });
    rooms.set(roomId, room);
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  let activeRoom = null;

  socket.on('join_match', ({ roomId = 'border-sector-1', mode = 'TDM', callsign, loadout, team }) => {
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

  socket.on('deploy_drone', ({ mode }) => {
    if (activeRoom) activeRoom.handleDeployDrone(socket.id, mode);
  });

  socket.on('control_drone', (input) => {
    if (activeRoom) activeRoom.handleControlDrone(socket.id, input);
  });

  socket.on('use_heal', ({ item }) => {
    if (activeRoom) activeRoom.handleHeal(socket.id, item);
  });

  socket.on('loot_airdrop', ({ crateId }) => {
    if (activeRoom) activeRoom.handleLootAirdrop(socket.id, crateId);
  });

  socket.on('disconnect', () => {
    if (activeRoom) activeRoom.removePlayer(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Game Server] Authoritative PVP Socket.IO running on http://localhost:${PORT}`);
});
