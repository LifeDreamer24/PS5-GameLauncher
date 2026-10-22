// Keep one still frame behind the launcher quick menu, then crossfade back.
import { api, emit } from '../state.js';

let active = null;

export function freezeMenuBackground() {
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
  let finishWait;
  const cancelled = new Promise((resolve) => { finishWait = resolve; });
  const syncDim = () => image?.classList.toggle('dimmed', app.classList.contains('dimmed'));
  const onResize = () => controller.release(true);
  const controller = {
    ready: null,
    release(immediate = false) {
      if (released) {
        if (immediate) {
          image?.remove();
          if (active === controller) active = null;
        }
        return;
      }
      released = true;
      clearTimeout(timeout);
      finishWait();
      window.removeEventListener('resize', onResize);
      app.classList.remove('menu-frozen', 'menu-freezing');
      emit('menu-background-frozen', false);
      // Match the live page's dim state before fading out the old scene.
      syncDim();
      observer?.disconnect();
      const remove = () => {
        image?.remove();
        if (active === controller) active = null;
      };
      if (image) {
        if (immediate || document.body.classList.contains('reduce-motion')) remove();
        else {
          image.classList.add('releasing');
          setTimeout(remove, 220);
        }
      }
      if (!image) remove();
    },
  };
  active = controller;
  app.classList.add('menu-freezing');
  emit('menu-background-frozen', true);
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
      observer = new MutationObserver(syncDim);
      observer.observe(app, { attributes: true, attributeFilter: ['class'] });
      syncDim();
      app.classList.add('menu-frozen');
    } catch {
      controller.release(true);
    }
  })();
  // Opening must remain responsive even if capturing the page fails or stalls.
  timeout = setTimeout(() => controller.release(true), 200);
  controller.ready = Promise.race([capture, cancelled]).then(() => clearTimeout(timeout));
  return controller;
}
