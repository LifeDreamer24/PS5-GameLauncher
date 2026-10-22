// Keep one still frame behind the launcher quick menu, then crossfade back.
import { api, emit } from '../state.js';

let active = null;

export function freezeMenuBackground() {
  // Reuse the still during the previous menu's closing animation.
  if (active?.retain()) return active;
  active?.release(true);
  const app = document.getElementById('app');
  // A full-page capture must not include an existing dialog, toast, or a
  // closing quick menu. Use the live backdrop in those uncommon cases.
  if (!app || !api.menuSnapshot || app.classList.contains('dimmed') ||
      document.getElementById('overlays')?.children.length ||
      document.getElementById('toasts')?.children.length) {
    return { ready: Promise.resolve(), release() {} };
  }

  let released = false;
  let image = null;
  let observer = null;
  let timeout = null;
  let fade = null;
  let removal = null;
  let openingTimer = null;
  let finishWait;
  const cancelled = new Promise((resolve) => { finishWait = resolve; });
  const syncDim = () => image?.classList.toggle('dimmed', app.classList.contains('dimmed'));
  const onResize = () => controller.release(true);
  const speed = () => Number.parseFloat(getComputedStyle(app).getPropertyValue('--spd')) || 1;
  const cancelFade = () => {
    clearTimeout(openingTimer);
    if (fade) {
      fade.onfinish = null;
      fade.cancel();
      fade = null;
    }
  };
  const enter = (opacity = 0) => {
    cancelFade();
    const finish = () => {
      if (released) return;
      clearTimeout(openingTimer);
      // Only stop the live scene once the still completely covers it.
      app.classList.add('menu-freezing', 'menu-frozen');
      emit('menu-background-frozen', true);
    };
    if (document.body.classList.contains('reduce-motion')) {
      finish();
      return;
    }
    fade = image.animate(
      [{ opacity }, { opacity: 1 }],
      { duration: 400 * speed(), easing: 'ease-in-out', fill: 'forwards' },
    );
    fade.onfinish = finish;
    openingTimer = setTimeout(() => {
      if (released) return;
      cancelFade(); // The underlying image style is fully opaque.
      finish();
    }, 400 * speed() + 100);
  };
  const controller = {
    ready: null,
    retain() {
      if (!released || !image || !image.isConnected) return false;
      clearTimeout(removal);
      const opacity = Number.parseFloat(getComputedStyle(image).opacity);
      cancelFade();
      released = false;
      active = controller;
      window.addEventListener('resize', onResize);
      observer.observe(app, { attributes: true, attributeFilter: ['class'] });
      syncDim();
      enter(opacity);
      return true;
    },
    release(immediate = false) {
      if (released) {
        if (immediate) {
          clearTimeout(removal);
          cancelFade();
          image?.remove();
          if (active === controller) active = null;
        }
        return;
      }
      const opacity = image ? Number.parseFloat(getComputedStyle(image).opacity) : 1;
      released = true;
      cancelFade();
      clearTimeout(timeout);
      finishWait();
      window.removeEventListener('resize', onResize);
      app.classList.remove('menu-frozen', 'menu-freezing');
      emit('menu-background-frozen', false);
      // Match the live page's dim state before fading out the old scene.
      syncDim();
      observer?.disconnect();
      const remove = () => {
        clearTimeout(removal);
        cancelFade();
        image?.remove();
        if (active === controller) active = null;
      };
      if (image) {
        if (immediate || document.body.classList.contains('reduce-motion')) remove();
        else {
          // Explicit endpoints avoid coalesced CSS styles on rapid toggles.
          // Hold the still briefly so the resumed page can paint underneath.
          const duration = 400 * speed();
          fade = image.animate(
            [{ opacity }, { opacity, offset: 0.1 }, { opacity: 0 }],
            { duration, easing: 'ease-out', fill: 'forwards' },
          );
          fade.onfinish = remove;
          removal = setTimeout(remove, duration + 100);
        }
      }
      if (!image) remove();
    },
  };
  active = controller;
  window.addEventListener('resize', onResize);

  const capture = (async () => {
    try {
      const data = await api.menuSnapshot();
      if (released || !data) return controller.release(true);
      const still = new Image();
      still.className = 'menu-backdrop';
      still.alt = '';
      still.setAttribute('aria-hidden', 'true');
      still.src = data;
      await still.decode();
      if (released) return;
      image = still;
      // Do not show a blank background while capture/decode is pending.
      app.after(image);
      // Commit the unfiltered frame before mountOverlay dims it.
      void getComputedStyle(image).filter;
      observer = new MutationObserver(syncDim);
      observer.observe(app, { attributes: true, attributeFilter: ['class'] });
      syncDim();
      // Start the transition without delaying the quick menu's own opening.
      enter();
    } catch {
      controller.release(true);
    }
  })();
  // Opening must remain responsive even if capturing the page fails or stalls.
  timeout = setTimeout(() => {
    console.warn('Quick-menu background capture timed out; using the live background.');
    controller.release(true);
  }, 1000);
  controller.ready = Promise.race([capture, cancelled]).then(() => clearTimeout(timeout));
  return controller;
}
