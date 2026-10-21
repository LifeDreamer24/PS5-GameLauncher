// In-game overlay: a transparent, always-on-top window that shows the quick
// menu above whatever is in the foreground. It is a normal separate window —
// nothing is injected into or read from the game.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

class OverlayManager {
  /**
   * @param {object} o
   * @param {import('./system').SystemBridge} o.system
   */
  constructor({ system, onVisibility, onBeforeShow, onIdle }) {
    this.system = system;
    this.onVisibility = onVisibility || (() => {});
    // The launcher wakes up from its in-game sleep before anything shows, and
    // may go back to sleep once nothing is on screen any more.
    this.onBeforeShow = onBeforeShow || (() => {});
    this.onIdle = onIdle || (() => {});
    this.win = null;
    this.visible = false;
    this.prevForeground = null;
    this.hideTimer = null;
  }

  create() {
    const win = new BrowserWindow({
      show: false,
      // Otherwise a window that hasn't been shown yet counts as visible and
      // keeps rendering frames at full speed in the background.
      paintWhenInitiallyHidden: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      title: 'PS5 Game Launcher Overlay',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // While hidden the page counts as hidden (no animation frames, slow
        // timers), so it costs the game nothing; switched off while shown.
        backgroundThrottling: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMenu(null);
    win.loadURL('app://ui/overlay.html');
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12' && process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
    });
    win.on('closed', () => {
      this.win = null;
      this.visible = false;
    });
    this.win = win;
    return win;
  }

  /** Hidden: let Chromium idle the page. Shown: full speed. */
  awake(on) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.setBackgroundThrottling(!on);
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  hwndOf(win) {
    try {
      const buf = win.getNativeWindowHandle();
      return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    } catch {
      return 0;
    }
  }

  /** Show the overlay on the monitor of the current foreground window. */
  /**
   * A notification over the game: the window is shown without focus and lets
   * every click through, so the game keeps running as before.
   */
  async popup(n) {
    if (!this.win) this.create();
    this.onBeforeShow();
    this.awake(true);
    this.send('overlay:toast', n);
    this.toastUntil = Math.max(this.toastUntil || 0, Date.now() + (n.duration || 5000) + 900);
    // While a menu is open the toast shows in it; hideNow keeps it up after.
    if (this.visible) return;
    if (!this.toastShown) {
      const fg = await this.system.foreground();
      const display = fg && fg.w > 0 ? screen.getDisplayMatching({ x: fg.x, y: fg.y, width: fg.w, height: fg.h }) : screen.getPrimaryDisplay();
      this.win.setBounds(display.bounds);
      this.win.setIgnoreMouseEvents(true);
      this.win.showInactive();
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.toastShown = true;
    }
    this.holdForToasts();
  }

  /** Keep the (click-through) window up until the last toast is gone. */
  holdForToasts() {
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastShown = false;
      if (!this.visible && this.win) {
        this.win.hide();
        this.awake(false);
      }
      if (this.win) this.win.setIgnoreMouseEvents(false);
      if (!this.visible) this.onIdle();
    }, Math.max(0, (this.toastUntil || 0) - Date.now()));
  }

  async show(info = {}) {
    if (!this.win) this.create();
    if (this.visible) return;
    // 'menu' (quick menu) or 'capture' (capture menu, never pauses the game)
    this.mode = info.mode || 'menu';
    this.onBeforeShow();
    this.awake(true);
    clearTimeout(this.hideTimer);
    clearTimeout(this.toastTimer);
    this.toastShown = false;
    this.win.setIgnoreMouseEvents(false);
    this.visible = true;
    const fg = await this.system.foreground();
    this.prevForeground = fg && fg.hwnd ? fg.hwnd : null;
    const display = fg && fg.w > 0 ? screen.getDisplayMatching({ x: fg.x, y: fg.y, width: fg.w, height: fg.h }) : screen.getPrimaryDisplay();
    this.win.setBounds(display.bounds);
    this.send('overlay:open', info);
    this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.moveTop();
    this.system.setPadForward(true);
    this.onVisibility(true);
    // Take focus so the game stops reacting to input while the menu is open
    // (games read the controller only while they are the foreground window).
    // Fullscreen games sometimes take it straight back, so keep claiming it.
    const hwnd = this.hwndOf(this.win);
    const ok = await this.system.focusWindow(hwnd);
    if (!ok) this.win.focus();
    clearInterval(this.focusTimer);
    this.focusTimer = setInterval(async () => {
      if (!this.visible || !this.win) return clearInterval(this.focusTimer);
      const fg = await this.system.foreground();
      if (this.visible && fg && Number(fg.hwnd) !== Number(hwnd)) {
        await this.system.focusWindow(hwnd);
        this.win.moveTop();
      }
    }, 400);
  }

  /** Ask the overlay page to play its closing animation (it calls hideNow after). */
  requestClose() {
    if (!this.visible) return;
    this.send('overlay:close');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideNow(), 900);
  }

  async hideNow({ restoreFocus = true } = {}) {
    clearTimeout(this.hideTimer);
    if (!this.win || !this.visible) return;
    this.visible = false;
    clearInterval(this.focusTimer);
    this.system.setPadForward(false);
    // Whatever is still open in the page goes too (it opened the launcher, or
    // the game ended), so it never shows up again with the next menu or toast.
    this.send('overlay:hidden');
    if ((this.toastUntil || 0) > Date.now()) {
      // A notification arrived while the menu was open (e.g. "Screenshot
      // saved" right after the capture menu closed): leave it on screen,
      // click-through, until it ends.
      this.win.setIgnoreMouseEvents(true);
      this.toastShown = true;
      this.holdForToasts();
    } else {
      this.win.hide();
      this.awake(false);
    }
    // Resume a paused game before it gets focus back.
    await this.onVisibility(false);
    if (restoreFocus && this.prevForeground) await this.system.focusWindow(this.prevForeground);
    this.prevForeground = null;
  }

  toggle(info) {
    if (this.visible) this.requestClose();
    else this.show(info);
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { OverlayManager };
