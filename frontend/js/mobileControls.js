// Mobile Touch Controls: Virtual Joystick + Touch-Drag Aim + Action Buttons

export class MobileControls {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.enabled =
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      window.matchMedia('(pointer: coarse)').matches;

    this.moveX = 0;
    this.moveY = 0; // +1 = forward, -1 = backward

    this._joyTouchId = null;
    this._joyCenter = { x: 0, y: 0 };
    this._lookTouchId = null;
    this._lastLook = { x: 0, y: 0 };

    this.container = document.getElementById('mobile-controls');
    this.joyBase = document.getElementById('joy-base');
    this.joyKnob = document.getElementById('joy-knob');
    this.lookZone = document.getElementById('touch-look-zone');

    if (this.container) {
      this._bindEvents();
    }
  }

  show() {
    if (this.enabled && this.container) {
      this.container.classList.remove('hidden');
    }
  }

  hide() {
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }

  _bindEvents() {
    // Left Virtual Joystick
    this.joyBase.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this._joyTouchId = t.identifier;
      const rect = this.joyBase.getBoundingClientRect();
      this._joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      this._updateJoystick(t.clientX, t.clientY);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyTouchId) {
          e.preventDefault();
          this._updateJoystick(t.clientX, t.clientY);
        } else if (t.identifier === this._lookTouchId) {
          e.preventDefault();
          const dx = t.clientX - this._lastLook.x;
          const dy = t.clientY - this._lastLook.y;
          this._lastLook = { x: t.clientX, y: t.clientY };
          this.callbacks.onLook(dx, dy);
        }
      }
    }, { passive: false });

    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyTouchId) {
          this._joyTouchId = null;
          this.moveX = 0;
          this.moveY = 0;
          this.joyKnob.style.transform = 'translate(-50%, -50%)';
        }
        if (t.identifier === this._lookTouchId) {
          this._lookTouchId = null;
        }
      }
    };
    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    // Right Touch-Drag Aim Zone
    this.lookZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this._lookTouchId !== null) return;
      const t = e.changedTouches[0];
      this._lookTouchId = t.identifier;
      this._lastLook = { x: t.clientX, y: t.clientY };
    }, { passive: false });

    // Action Buttons
    const bindBtn = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn(true);
      }, { passive: false });
      el.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn(false);
      }, { passive: false });
    };

    bindBtn('btn-fire', (down) => {
      if (down) this.callbacks.onFire();
    });
    bindBtn('btn-ads', (down) => this.callbacks.onAds(down));
    bindBtn('btn-jump', (down) => { if (down) this.callbacks.onJump(); });
    bindBtn('btn-crouch', (down) => { if (down) this.callbacks.onCrouch(); });
    bindBtn('btn-prone', (down) => { if (down) this.callbacks.onProne(); });
    bindBtn('btn-reload', (down) => { if (down) this.callbacks.onReload(); });
    bindBtn('btn-cam', (down) => { if (down) this.callbacks.onToggleCam(); });
    bindBtn('btn-swap', (down) => { if (down) this.callbacks.onSwapWeapon(); });
    bindBtn('btn-frag', (down) => { if (down) this.callbacks.onFrag(); });
    bindBtn('btn-smoke', (down) => { if (down) this.callbacks.onSmoke(); });
    bindBtn('btn-missile', (down) => { if (down) this.callbacks.onMissile(); });
    bindBtn('btn-fpv', (down) => { if (down) this.callbacks.onFpvDrone(); });
    bindBtn('btn-recon', (down) => { if (down) this.callbacks.onReconDrone(); });
    bindBtn('btn-heal', (down) => { if (down) this.callbacks.onHeal(); });
  }

  _updateJoystick(clientX, clientY) {
    const maxR = 42;
    let dx = clientX - this._joyCenter.x;
    let dy = clientY - this._joyCenter.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxR) {
      dx = (dx / dist) * maxR;
      dy = (dy / dist) * maxR;
    }
    this.moveX = dx / maxR;
    this.moveY = -dy / maxR;
    this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
}
