import { CONFIG } from './config.js';
import { io } from 'https://cdn.socket.io/4.7.4/socket.io.esm.min.js';

export async function fetchArsenal() {
  const res = await fetch(`${CONFIG.BACKEND_URL}/api/arsenal`);
  return res.json();
}

export async function fetchLeaderboard() {
  const res = await fetch(`${CONFIG.BACKEND_URL}/api/leaderboard`);
  return res.json();
}

export async function loginPlayer(callsign, password) {
  const res = await fetch(`${CONFIG.BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callsign, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function savePlayerLoadout(token, loadout) {
  const res = await fetch(`${CONFIG.BACKEND_URL}/api/loadout/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(loadout)
  });
  return res.json();
}

export function connectGameServer() {
  return io(CONFIG.GAME_SERVER_URL, { transports: ['websocket', 'polling'] });
}
