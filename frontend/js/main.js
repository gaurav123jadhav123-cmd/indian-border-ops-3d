// The page: finds the servers, shows the lobby, and starts / ends matches.
import { resolveConfig } from './config.js';
import { createApi } from './net/api.js';
import { Settings } from './settings.js';
import { AudioEngine } from './audio.js';
import { Lobby } from './ui/lobby.js';
import { Overlays } from './ui/overlays.js';
import { Game } from './game/Game.js';

/** Phone or tablet? (?touch=1 / ?touch=0 in the address forces it, for testing.) */
export function detectTouch(win) {
  const forced = new URLSearchParams(win.location?.search ?? '').get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  const mm = (q) => !!win.matchMedia?.(q).matches;
  if (mm('(pointer: coarse)')) return true;
  return (win.navigator?.maxTouchPoints ?? 0) > 0 && !mm('(pointer: fine)');
}

/** The 3D engine is loaded only when a match starts, so the lobby opens instantly. */
export async function loadRenderer() {
  const mod = await import('./render/index.js');
  return mod.createRenderer;
}

export class App {
  constructor({
    win = window,
    doc = document,
    config = resolveConfig({ location: win.location, env: win.__BORDER_OPS_ENV__ }),
    api = null,
    settings = new Settings(),
    audio = null,
    ioFactory = null,
    rendererLoader = loadRenderer
  } = {}) {
    this.win = win;
    this.doc = doc;
    this.config = config;
    this.api = api ?? createApi({ baseUrl: config.api });
    this.settings = settings;
    this.audio = audio ?? new AudioEngine({ settings });
    this.ioFactory = ioFactory;
    this.rendererLoader = rendererLoader;
    this.isTouch = detectTouch(win);
    this.game = null;
    this.lastDeploy = null;
  }

  $(id) {
    return this.doc.getElementById(id);
  }

  init() {
    const { doc, win } = this;
    doc.body.classList.toggle('touch', this.isTouch);

    // 1% of the visible height, so the touch buttons size themselves right on every phone
    const setVh = () => doc.documentElement.style.setProperty('--vh', `${(win.innerHeight || 400) / 100}px`);
    setVh();
    win.addEventListener('resize', setVh);
    win.addEventListener('orientationchange', setVh);

    // browsers only allow sound after a tap
    const unlock = () => this.audio.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) win.addEventListener(ev, unlock, { passive: true });
    // stop the browser's own pinch-zoom while playing (iOS)
    doc.addEventListener('gesturestart', (e) => e.preventDefault());
    doc.addEventListener('contextmenu', (e) => { if (this.game) e.preventDefault(); });
    win.addEventListener('pagehide', () => this.game?.stop());

    this.overlays = new Overlays({ doc, root: this.$('overlay-root'), settings: this.settings, isTouch: this.isTouch });
    const canFullscreen = !!doc.documentElement.requestFullscreen;
    this.lobby = new Lobby({
      doc,
      root: this.$('lobby'),
      api: this.api,
      isTouch: this.isTouch,
      onDeploy: (params) => this.startMatch(params),
      onGesture: () => this.onDeployTap(),
      onOpenSettings: () => this.overlays.showSettings({ onClose: () => this.overlays.close() }),
      onFullscreen: canFullscreen ? () => this.enterFullscreen() : null
    });
    if (this.config.room) this.lobby.roomInput.value = this.config.room;

    // the lobby fills in while these load; each one fails quietly into its own message
    this.lobby.restore();
    this.lobby.loadArsenal();
    this.lobby.loadLeaderboard();

    if (this.config.debug) win.__bop = this;
    return this;
  }

  // ------------------------------------------------------------------ full screen
  async enterFullscreen() {
    const { doc, win } = this;
    const root = doc.documentElement;
    try {
      if (!doc.fullscreenElement && root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    } catch { /* the browser said no: not a problem */ }
    try {
      await win.screen?.orientation?.lock?.('landscape');
    } catch { /* only works in full screen on some phones */ }
  }

  /** Runs inside the tap on DEPLOY. */
  onDeployTap() {
    this.audio.unlock();
    if (this.isTouch) this.enterFullscreen();
  }

  // ------------------------------------------------------------------ matches
  async startMatch(params) {
    this.lastDeploy = params;
    let rendererFactory;
    try {
      rendererFactory = await this.rendererLoader();
    } catch (err) {
      console.error('[3D engine]', err);
      throw new Error('Could not load the 3D engine. Check your internet connection and try again.');
    }

    const game = new Game({
      doc: this.doc,
      win: this.win,
      stage: this.$('stage'),
      hudRoot: this.$('hud'),
      touchRoot: this.$('touch-layer'),
      isTouch: this.isTouch,
      settings: this.settings,
      audio: this.audio,
      serverUrl: this.config.server,
      ioFactory: this.ioFactory,
      rendererFactory,
      callbacks: {
        onMenuRequest: () => this.openMenu(),
        onMatchEnd: (payload, ctx) => this.showResult(payload, ctx),
        onLeft: (message) => this.showError(message, 'Disconnected'),
        onFatal: (message) => this.showError(message, 'Game stopped')
      }
    });
    this.game = game;
    try {
      await game.start(params); // cleans up after itself when it fails
    } catch (err) {
      this.game = null;
      throw err;
    }
    this.doc.body.classList.add('playing');
    this.lobby.hide();
    if (this.config.debug) this.win.__game = game;
  }

  teardownGame() {
    this.game?.stop();
    this.game = null;
    this.doc.body.classList.remove('playing');
  }

  leaveToLobby() {
    this.teardownGame();
    this.overlays.close();
    this.lobby.show();
    this.lobby.loadLeaderboard();
  }

  openMenu() {
    const game = this.game;
    if (!game || this.overlays.isOpen) return;
    game.setPaused(true);
    this.overlays.showMenu({
      onResume: () => game.setPaused(false),
      onSettings: () => this.overlays.showSettings({ onClose: () => { this.overlays.close(); this.openMenu(); } }),
      onLeave: () => this.leaveToLobby()
    });
  }

  showResult(payload, ctx) {
    this.overlays.close();
    this.overlays.showResult(payload, ctx, {
      onAgain: () => this.playAgain(),
      onLobby: () => this.leaveToLobby()
    });
  }

  showError(message, title) {
    this.overlays.close();
    this.overlays.showError(message, { title, onBack: () => this.leaveToLobby() });
  }

  async playAgain() {
    const params = this.lastDeploy;
    this.teardownGame();
    try {
      await this.startMatch(params);
    } catch (err) {
      this.showError(err?.message || 'Could not join a new match.', 'Could not rejoin');
    }
  }
}

// start automatically when loaded as the page's script (not when imported by a test)
if (typeof document !== 'undefined' && document.getElementById('lobby') && !globalThis.__BOP_NO_AUTOSTART__) {
  new App().init();
}
