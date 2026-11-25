# Indian Border Ops 3D — Tactical 5v5 Multiplayer FPS

A 3D browser & mobile-playable multiplayer PVP FPS inspired by Indian Army border operations, split into **Frontend**, **Backend**, and **Game Server** folders.

## Key Features
- **Indian Army Arsenal**: SIG 716 G2, AK-203, INSAS 1B1, Tavor TAR-21, ASMI 9mm, Dragunov SVD, Sako TRG-42, Vidhwansak AMR, Negev NG7, Pistol Auto 9mm 1A, and Carl Gustaf M4.
- **5v5 (10-Player) PVP + Tactical AI Bots**: Automatic bot backfill (5 Bharat vs 5 OPFOR) with line-of-sight checks, cover/healing AI, and instant human-for-bot replacement.
- **Mobile Landscape & Desktop Controls**: Virtual thumbstick, full-screen touch-drag aiming, hold-to-auto-fire, lean (`L<`/`>R`), crouch/prone, drone altitude/exit buttons, and 2D tactical minimap radar.
- **Combat & Tactical Systems**: Auto-reload on empty magazine, 3D bullet tracers, spinning frag/smoke grenades, Carl Gustaf rocket trajectories, multi-stage explosions, floating damage numbers, 5-second respawns, COD-style killstreaks (3/5/7 kills), FPV & Recon drones, Free Fire-style Air Drops, and BGMI-style healing/boosts.
- **Backend & Progression**: Atomic JSON store, military rank progression (`Sepoy` to `Brigadier`), K/D tracking, rate-limited auth, and no-cache static serving.

## Project Structure
```
indian-border-ops-3d/
├── frontend/     # Three.js 3D WebGL Client + Mobile Touch HUD
├── backend/      # Express REST API (Auth, Ranks, Loadouts, Leaderboard)
└── server/       # Authoritative 20Hz Socket.IO 5v5 Server (Anti-Cheat, Occlusion, Bots)
```

## Quick Local Setup
1. `cd backend && npm install && npm start` (Port `4000`)
2. `cd server && npm install && npm start` (Port `5000`)
3. Open `http://localhost:4000` in your browser.
