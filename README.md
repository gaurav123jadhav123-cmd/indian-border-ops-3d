# Indian Border Ops 3D — Multiplayer PVP FPS

A 3D browser-based multiplayer PVP first-person shooter inspired by Indian Army border operations, combining:
- **Indian Army Arsenal**: SIG 716 G2, AK-203, INSAS 1B1, Tavor TAR-21, ASMI SMG, Dragunov SVD, Sako TRG-42, Vidhwansak AMR, Negev NG7, Pistol Auto 9mm 1A, and Carl Gustaf M4.
- **Border Terrain**: 3D high-altitude Himalayan border sector (ridges, bunkers, watchtowers, checkpoints, river valley, and airdrop zones) with deterministic heightmap shared between client and server.
- **COD-Style Tactical Gear**: Frag & Smoke grenades, Tactical Airstrike Missiles, **1st-Person FPV Attack Drone**, and **3rd-Person Recon Overwatch Drone**.
- **Free Fire-Style Air Drops**: Periodic supply crates dropping with smoke beacons and high-tier weapons/armor.
- **BGMI-Style Movement & Healing**: Sprint, Crouch, Prone, Left/Right Lean (Q/E), Bandages, First Aid Kits, Medkits, and Energy Drinks (boost bar with passive regen + speed).

## Project Structure (3-Part Split)

```
indian-border-ops-3d/
├── frontend/     # 3D Three.js WebGL Client (HTML/CSS/ES Modules)
├── backend/      # Node.js + Express REST API (Auth, Loadouts, Leaderboard, Arsenal)
└── server/       # Node.js + Socket.IO Authoritative PVP Game Server (30Hz Tick)
```

## Quick Local Setup

1. **Install dependencies** in both `backend` and `server`:
   ```bash
   cd backend && npm install
   cd ../server && npm install
   ```
2. **Start the Backend API** (port `4000`, also serves `frontend/`):
   ```bash
   cd backend && npm start
   ```
3. **Start the PVP Game Server** (port `5000`):
   ```bash
   cd server && npm start
   ```
4. **Play**: Open `http://localhost:4000` in two or more browser tabs/windows to test PVP multiplayer.

## Controls
- **W A S D**: Move | **Shift**: Sprint | **Space**: Jump
- **C**: Toggle Crouch | **Z**: Toggle Prone | **Q / E**: Lean Left / Right
- **Mouse**: Aim | **Left Click**: Fire | **Right Click**: Aim Down Sights (ADS)
- **1 / 2 / 3**: Primary / Secondary / Launcher | **R**: Reload
- **G**: Frag Grenade | **T**: Smoke Grenade | **V**: Toggle 1st / 3rd Person Camera
- **4**: Call Tactical Missile Strike | **5**: Deploy 1st-Person FPV Attack Drone | **6**: Deploy 3rd-Person Recon Drone
- **7 / 8 / 9 / 0**: Use Bandage / First Aid Kit / Medkit / Energy Drink
- **F**: Loot Air Drop Crate

## Deploying Online
- Deploy `server/` and `backend/` to a persistent Node.js host (**Railway**, **Render**, **Fly.io**, or a **VPS**).
- Host `frontend/` on **Vercel**, **Netlify**, or serve it from `backend/`.
- Update `CONFIG.BACKEND_URL` and `CONFIG.GAME_SERVER_URL` in `frontend/js/config.js` to your live URLs.
