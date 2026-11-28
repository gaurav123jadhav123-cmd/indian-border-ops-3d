// Backend entry point: REST API (+ optionally serves the game page from ../frontend).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { loadConfig } from './config.js';
import { Store } from './services/store.js';
import { createServices } from './services/index.js';
import { routes } from './routes/index.js';
import { createApp } from './app.js';

const log = {
  info: (...a) => console.log('[backend]', ...a),
  warn: (...a) => console.warn('[backend]', ...a),
  error: (...a) => console.error('[backend]', ...a)
};

const config = loadConfig();
if (config.usingDevSecret) {
  log.warn('SHARED_SECRET is not set: using an insecure development secret. Fine on your own phone/PC, never on the internet.');
}

const store = new Store({ dir: config.dataDir, log }).load();
const services = createServices({ config, store, log });

const hasFrontend = config.serveFrontend && fs.existsSync(path.join(config.frontendDir, 'index.html'));
const app = createApp({ express, cors, routes, services, config: { ...config, serveFrontend: hasFrontend }, log });

const server = app.listen(config.port, () => {
  log.info(`API listening on port ${config.port}${hasFrontend ? ' (also serving the game page)' : ''}`);
  log.info(`database: ${store.file} (${store.counts().users} players)`);
});

async function shutdown(signal) {
  log.info(`${signal} received, saving and shutting down`);
  server.close();
  await store.flush();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
