# Indian Border Ops 3D

A 3D browser multiplayer PVP first-person shooter set on the Himalayan border. It runs in a normal
phone or PC browser (touch controls on phones, mouse and keyboard on PCs).

- **Indian Army arsenal**: SIG 716 G2, AK-203, INSAS 1B1, Tavor TAR-21, ASMI 9mm, Dragunov SVD, Pistol Auto 9mm 1A and the Carl Gustaf M4 launcher. Air drops also carry the Sako TRG-42, Vidhwansak AMR and Negev NG7.
- **Border terrain**: a high-altitude sector with ridges, bunkers, a checkpoint, watchtowers, a frozen river valley and air-drop zones. The ground height is the same code on the server and in your browser, so what you see is what you bump into.
- **Tactical gear**: frag and smoke grenades, a missile strike, a first-person FPV attack drone and a third-person recon drone.
- **Air drops**: supply crates fall from the sky on a timer and carry the best weapons and armour.
- **Movement and healing**: sprint, crouch, prone, lean, bandages, first aid kits, medkits and energy drinks.
- **Accounts or guests**: play instantly as a guest, or register a callsign to keep your loadout and appear on the leaderboard.

---

## What is in this folder

```
indian-border-ops-3d/
├── frontend/   The game in the browser (Three.js + plain JavaScript, no build step)
├── backend/    REST API: guest/account sign-in, loadouts, arsenal list, leaderboard. Also serves the page.
├── server/     The multiplayer game server (Socket.IO). It decides everything that happens in a match.
├── shared/     Code that must be identical everywhere (weapons, tokens, world/terrain maths)
├── scripts/    start-all.mjs, check-all.mjs, sync-shared.mjs
└── test/       Tests that run the frontend, backend and server together
```

`shared/` is copied into the three parts by `npm run sync`, so each part still works when it is
deployed on its own. `npm run check:shared` tells you if a copy has been edited by mistake.

---

## Play on your Android phone (Termux)

You do not need a laptop. The phone runs the game server and the browser at the same time.

1. Install **Termux** from **F-Droid** (the Play Store copy is out of date).
2. Open Termux and run:
   ```
   pkg update -y && pkg upgrade -y
   pkg install -y nodejs-lts unzip
   termux-setup-storage
   ```
   Allow the storage permission when Android asks.
3. Unpack the game (the zip is in your Downloads folder):
   ```
   cd ~
   unzip ~/storage/downloads/indian-border-ops-3d.zip
   cd indian-border-ops-3d
   ```
4. Install the two packages the servers need (needs internet, once):
   ```
   npm run install:all
   ```
5. Start the game:
   ```
   termux-wake-lock
   npm start
   ```
6. Open **Chrome** on the same phone and go to **http://localhost:4000**. Turn the phone sideways, pick a callsign and press **DEPLOY**.

**Friends on the same Wi-Fi or hotspot:** `npm start` prints an address such as `http://192.168.1.23:4000`.
They open it in their browser and type the same room code as you. If it prints no address, look up your
phone's Wi-Fi address in the Wi-Fi settings and use `http://<that address>:4000`.

**Keep it running:** keep Termux open (do not swipe it away) and leave `termux-wake-lock` on, or Android may stop the servers.
Stop the game with **Ctrl+C** (volume-down + C on the Termux keyboard row).

The browser needs internet once per session, because it loads the 3D library (three.js) and the Socket.IO
client from a public CDN. To play fully offline, see "Playing without internet" at the end.

## Play on a PC

```
npm run install:all
npm start
```

Open http://localhost:4000 in two tabs to try a match against yourself. You need Node.js 18.17 or newer.

---

## Controls

### Phone (landscape)

| What | How |
|---|---|
| Move | Put your left thumb anywhere on the left side and drag. Push all the way to sprint. |
| Look | Drag on the right side of the screen. |
| Fire | **FIRE** button (hold for automatic weapons). Slide your thumb while holding to aim. |
| Aim / scope | **AIM** (tap to switch on and off) |
| Jump, reload | **JUMP**, **RELOAD** |
| Crouch / prone / stand | **STANCE** (tap again to go lower, then back up) |
| Grenades | **FRAG**, **SMOKE** (the badge shows how many you have left) |
| Weapons | Tap the weapon chips at the bottom (rifle, pistol, launcher) |
| Missile, drones, camera, healing | **MORE** opens a drawer: MISSILE, FPV DRONE, RECON, VIEW, BANDAGE, FIRST AID, MEDKIT, ENERGY, CANCEL |
| Loot a crate | **LOOT** appears when you stand next to a landed crate |
| In a drone | Left thumb flies, right thumb looks. **UP / DOWN** change height, **BOOM** blows up an FPV drone, **EXIT** brings it home |
| Menu, settings, scoreboard | **☰** opens the menu (settings and leaving are inside it). Hold **≣** to see the scoreboard. |

### Keyboard and mouse

| Key | Action | Key | Action |
|---|---|---|---|
| W A S D | Move | Q / E | Lean left / right |
| Shift | Sprint | Space | Jump |
| C | Crouch | Z | Prone |
| Mouse | Look | Left click | Fire |
| Right click | Aim down sights | R | Reload |
| 1 / 2 / 3 | Primary / pistol / launcher | G / T | Frag / smoke grenade |
| 4 | Call a missile strike | 5 / 6 | FPV drone / recon drone |
| 7 / 8 / 9 / 0 | Bandage / first aid / medkit / energy drink | F | Loot a crate |
| V | First / third person | Tab | Scoreboard (hold) |
| X | Detonate FPV drone | B | Bring the drone home |
| Esc | Pause menu (it also opens when the mouse is released) | Shift / Space in a drone | Down / up |

---

## How a match works

- **Modes**: Team Deathmatch (Bharat against OPFOR, first to 25 kills) and Free For All (first to 15 kills). A match lasts 8 minutes; the higher score wins and a tie is a draw.
- **Rooms**: everybody who types the same room code lands in the same match. Up to 12 players per room.
- **Respawn**: 4.5 seconds after you die, with 3 seconds of spawn protection.
- **Air drops**: the first one falls after 20 seconds, then one about every 45 seconds, up to 3 on the map.
- **Missile strike**: aim where it should land (22 to 120 metres away). Cooldown 45 seconds.
- **Drones**: the FPV drone is a flying bomb (22 seconds of flight), the recon drone watches from the sky for 30 seconds. Both have a 35 second cooldown and can be shot down.
- **Connection drops**: you have 30 seconds to come back and carry on as the same soldier.

---

## Putting it online

You need two small Node.js services (any host that runs Node and allows WebSockets: Render, Railway, Fly.io, a VPS...).

1. Create one long random secret and give the **same value** to both services:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Backend** (folder `backend/`, start command `npm start`): set `NODE_ENV=production`, `SHARED_SECRET`, `TRUST_PROXY=1`,
   `CORS_ORIGIN` (your site's address) and `DATA_DIR` (a folder on a persistent disk, otherwise accounts are lost on every deploy).
3. **Game server** (folder `server/`, start command `npm start`): set `NODE_ENV=production`, `SHARED_SECRET` (same value),
   `BACKEND_URL` (the backend's public address) and `CORS_ORIGIN`.
4. Open `frontend/env.js` and put the public addresses in it:
   ```js
   window.__BORDER_OPS_ENV__ = {
     API_URL: 'https://your-backend.example.com',
     GAME_SERVER_URL: 'https://your-game-server.example.com'
   };
   ```
   The backend serves the `frontend/` folder by default, so players only need the backend's address.
   To host the page somewhere else (Netlify, Vercel...), upload `frontend/` there and set `SERVE_FRONTEND=0` on the backend.
5. Run **one** game-server instance: matches live in its memory.

The backend and the game server both refuse to start in production without `SHARED_SECRET`.

### Settings

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `PORT` | both | 4000 / 5000 | Port to listen on |
| `SHARED_SECRET` | both | random for `npm start`; required in production | Signs login tokens and the match reports. Must be identical on both. |
| `BACKEND_URL` | server | `http://localhost:4000` | Where the game server sends finished-match results |
| `CORS_ORIGIN` | both | `*` | Allowed website origins, comma separated |
| `DATA_DIR` | backend | `backend/data` | Folder of `db.json` (accounts, leaderboard) |
| `TRUST_PROXY` | backend | off | Set to `1` behind a host's proxy so rate limits see real addresses |
| `SERVE_FRONTEND` | backend | on | `0` = do not serve the game page |
| `TOKEN_TTL_DAYS` | backend | 7 | How long a registered login stays valid (guests: 12 hours) |
| `MAX_ROOMS`, `ROOM_CAPACITY` | server | 20, 12 | Size limits |
| `BACKEND_PORT`, `GAME_PORT` | `npm start` | 4000, 5000 | Ports used by `npm start` |

Each of `backend/` and `server/` has a `.env.example` with these settings explained.
Page address options for testing: `?room=myroom` pre-fills the room code; on a local or private
network `?api=http://host:port&server=http://host:port` points the page at other servers.

---

## Tests

```
npm test            runs everything below, one after another
npm run test:browser   the same plus the browser tests (needs Playwright and Chromium)
```

| Suite | What it covers |
|---|---|
| `server/test` | Combat, damage, grenades, rockets, missiles, drones, air drops, healing, anti-cheat, rate limits, message validation, rooms |
| `backend/test` | Sign-up and login, guests, tokens, loadouts, leaderboard, match reports, the database file |
| `frontend/test/unit` | Settings, REST client, connection and reconnect logic, movement, input, smoothing, game state, graphics quality, small helpers (damage arrows, hit test, result text) and source guards (imports resolve, no unsafe HTML, the 3D engine kept out of game logic) |
| `test/integration` | The real browser-side client code against the real backend and game server in one process: sign-in, join, walking without corrections, a cheat being pulled back, a fight, the leaderboard, play again, reconnect, a second device |
| `frontend/test/e2e` | A real Chromium page playing a whole match: lobby, accounts, keyboard and touch play, death and respawn, menus, drones, healing, reconnect, button layout on three phone sizes |

**What these tests could not cover.** They were written and run on a machine without internet, so the
real packages (Express, Socket.IO, Three.js) were not installed there:

- The two small start-up files (`backend/src/index.js`, `server/src/index.js`) and `backend/src/app.js`, which connect Express and Socket.IO to the tested code, were run only against stand-ins. If something is wrong on your first start, it will be in those lines.
- The browser tests use a stand-in for Three.js, so they prove the game logic, controls and screens, but not how the 3D scene looks or how fast it runs. Check that on your own phone, and use **Settings > Graphics** if it is slow.
- Touch feel (button size, thumb reach, sensitivity) can only be judged by playing.

---

## How it works (for developers)

- **The server is in charge.** The game server simulates every match at 30 Hz and sends each player a snapshot at 20 Hz. The browser sends only its wish (move, shoot, throw); hits, damage, kills and pickups are decided on the server. Other players are drawn about 100 ms in the past so their movement looks smooth.
- **Movement is checked, not trusted.** The browser walks with the same maths as the server (`shared/world.js`). The server allows a small "movement budget" per second; a player who is further off than 2.5 m is pulled back with a `correction` message, and an `epoch` counter makes the server ignore old movement messages sent before the pull-back.
- **Sign-in.** Passwords are hashed with scrypt. Login tokens are signed with HMAC-SHA256 using `SHARED_SECRET`; the game server verifies them itself and reports finished matches to the backend with a short-lived signed service token.
- **Abuse limits.** Every socket has per-event rate limits (flooding gets the player kicked), every message is sanitised, and the REST API has per-address rate limits and small request bodies.
- **The REST API is a table** (`backend/src/routes`), run by a dispatcher that does not depend on Express, so it is tested directly. `app.js` is the only file that connects it to Express.
- **Frontend layout**: `js/game` (input, movement, smoothing, state, the `Game` class that ties it together), `js/render` (everything that touches Three.js; the rest of the code never imports it), `js/ui` (lobby, HUD, touch controls, menus), `js/net` (REST and Socket.IO clients).
- **Client messages**: `join_match`, `player_move`, `switch_weapon`, `reload`, `shoot`, `throw_grenade`, `call_missile`, `deploy_drone`, `control_drone`, `drone_action`, `use_heal`, `cancel_heal`, `loot_airdrop`, `leave_match`.
- **Balancing** lives in one file, `server/src/rules.js`; weapons are in `shared/arsenal.js` (run `npm run sync` after editing anything in `shared/`).

### Playing without internet

The page loads two libraries from a CDN: three.js 0.160.0 (`frontend/index.html`, the import map) and the Socket.IO client 4.7.5 (`frontend/js/net/socket.js`). To host them yourself, download those two files into `frontend/vendor/` and change the two addresses to point there.

### Limits to know about

- No lag compensation: shots are judged where the server sees players now, so a player with a very slow connection is at a disadvantage.
- Matches live in memory. Restarting the game server ends all running matches.
- Accounts are kept in one JSON file (`db.json`). That is fine for friends and small communities, not for thousands of players.
- Chat, voice and anti-cheat beyond movement, rate and message checks are not included.

## Troubleshooting

| Message or problem | What to do |
|---|---|
| "Cannot reach the server" in the lobby | The backend is not running, or the page was opened from another address. Open the address `npm start` printed. |
| "Could not reach the game server" | The game server is not running or port 5000 is blocked. In production check `GAME_SERVER_URL` in `frontend/env.js`. |
| "Could not load the networking library" or a black screen | The phone has no internet for the CDN. See "Playing without internet". |
| `npm start` says the packages are not installed | Run `npm run install:all` once, with internet. |
| Slow or choppy | Menu (☰) > Settings > Graphics > Low (it applies from the next match). The game also lowers its resolution by itself when your device struggles. Close other apps. |
| Login works but a match never starts | `SHARED_SECRET` differs between the backend and the game server. |
| Friends cannot connect | Same Wi-Fi or hotspot, use the address with `:4000`, and make sure ports 4000 and 5000 are not blocked. |
