// Game server entry point: HTTP health endpoint + Socket.IO + the 30Hz match loop.
import http from 'node:http';
import { Server } from 'socket.io';
import { loadConfig } from './config.js';
import { RoomManager } from './rooms/RoomManager.js';
import { attachSocket } from './net/handlers.js';
import { createReporter } from './net/report.js';

const config = loadConfig();

const log = {
  info: (...a) => console.log('[game]', ...a),
  warn: (...a) => console.warn('[game]', ...a),
  error: (...a) => console.error('[game]', ...a)
};

if (config.usingDevSecret) {
  log.warn('SHARED_SECRET is not set: using an insecure development secret. Fine on your own phone/PC, never on the internet.');
}

const reportMatch = createReporter({ backendUrl: config.backendUrl, secret: config.secret, log });

const manager = new RoomManager({
  maxRooms: config.maxRooms,
  capacity: config.roomCapacity,
  log,
  onMatchEnd: (report) => {
    // Matches with only guests have nothing to record.
    if (report.players.some((p) => p.userId)) reportMatch(report);
  }
});

const httpServer = http.createServer((req, res) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  if (req.url === '/health') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'indian-border-ops-game-server', ...manager.stats() }));
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
  res.end('Indian Border Ops 3D - authoritative game server');
});

const io = new Server(httpServer, {
  cors: { origin: config.corsOrigins, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e5,
  pingInterval: 10000,
  pingTimeout: 8000
});

io.on('connection', (socket) => attachSocket(socket, { manager, secret: config.secret, log }));

manager.start();
httpServer.listen(config.port, () => {
  log.info(`listening on port ${config.port} (backend: ${config.backendUrl})`);
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  manager.shutdown();
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
