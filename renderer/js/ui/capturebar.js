// The capture menu over a game (DualSense Create button, like the PS5's):
// the newest capture on the left (opens the Media Gallery), Save Recent
// Gameplay, Take Screenshot and Start/Stop Recording in the middle, Capture
// Options on the right. The game keeps running underneath (never paused).

import { h, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { api, on } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { mountOverlay, FocusList } from './overlay.js';
import { t } from '../i18n.js';

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * @param {object} o
 * @param {object} o.capture   capture state from the main process (obs.js publicState)
 * @param {(view: object) => void} o.navigate  open something in the launcher (closes the overlay)
 * @param {() => void} o.onClosed
 */
export function openCaptureBar({ capture, navigate, onClosed }) {
  let st = capture || {};
  let latest = null;
  let timer = null;

  const label = h('div', { class: 'cb-label' });
  const status = h('div', { class: 'cb-status' });
  const thumb = h('button', { class: 'cb-thumb fx', html: `<span class="cb-thumb-empty">${icon('gallery')}</span>` });
  const btn = (id) => h('button', { class: 'cb-btn fx', dataset: { id } });
  const clip = btn('clip');
  const shot = btn('screenshot');
  const rec = btn('record');
  const opts = h('button', { class: 'cb-btn cb-opt fx', dataset: { id: 'options' }, html: icon('sliders') });
  const items = [thumb, clip, shot, rec, opts];

  const root = h(
    'div',
    { class: 'overlay capture-bar' },
    h(
      'div',
      { class: 'cb-band' },
      h('div', { class: 'cb-left' }, thumb),
      h('div', { class: 'cb-center' }, h('div', { class: 'cb-row' }, clip, shot, rec), label),
      h('div', { class: 'cb-right' }, opts)
    ),
    status
  );

  const ready = () => st.status === 'ready';
  const labels = () => ({
    thumb: latest ? t('Media Gallery') : t('No captures yet'),
    clip: t('Save Recent Gameplay'),
    screenshot: t('Take Screenshot'),
    record: st.recording ? `${t('Stop Recording')}  ${fmtClock(Date.now() - (st.recordSince || Date.now()))}` : t('Start New Recording'),
    options: t('Capture Options'),
  });

  function render() {
    clip.innerHTML = icon('clipRecent');
    shot.innerHTML = icon('screenshot');
    rec.innerHTML = icon(st.recording ? 'recordStop' : 'record');
    rec.classList.toggle('recording', !!st.recording);
    for (const b of [clip, shot, rec]) b.classList.toggle('disabled', !ready());
    clip.classList.toggle('disabled', !ready() || !st.replay);
    const cur = nav.current;
    const id = cur === thumb ? 'thumb' : cur && cur.dataset.id;
    label.textContent = labels()[id] || '';
    let msg = '';
    if (st.status === 'starting') msg = t('Starting OBS…');
    else if (st.status !== 'ready') msg = t(st.error || 'Recording is not available.');
    else if (!st.replay) msg = t('Getting the replay buffer ready…');
    else if (!st.hooked) msg = t('OBS can’t see the game yet. Some games block capture tools.');
    status.textContent = msg;
    status.classList.toggle('show', !!msg);
  }

  async function loadLatest() {
    try {
      const list = await api.captureList();
      latest = list[0] || null;
    } catch {
      latest = null;
    }
    if (latest) {
      const src = latest.kind === 'image' ? latest.url : latest.thumbUrl;
      thumb.innerHTML = src ? `<img src="${escapeHtml(window.appUrl ? window.appUrl(src) : src)}" alt="">` : `<span class="cb-thumb-empty">${icon('play')}</span>`;
      if (latest.kind === 'video') thumb.insertAdjacentHTML('beforeend', `<span class="cb-thumb-badge">${icon('play')}</span>`);
    }
    render();
  }

  const nav = new FocusList(items, { index: 1, onChange: () => render() });
  items.forEach((el, i) => {
    el.addEventListener('mouseenter', () => mouseActive() && nav.set(i));
    el.addEventListener('click', () => {
      nav.set(i);
      choose();
    });
  });

  /** Close first, then capture: the bar must not end up in anything. */
  function act(kind) {
    sfx.select();
    ctl.close();
    setTimeout(() => api.captureAction(kind).catch(() => sfx.error()), 120);
  }

  function choose() {
    const cur = nav.current;
    if (cur === thumb) {
      sfx.select();
      if (latest) {
        ctl.close();
        navigate({ view: 'gallery' });
      }
      return;
    }
    const id = cur.dataset.id;
    if (id === 'options') {
      sfx.select();
      ctl.close();
      navigate({ view: 'settings', params: { category: 'captures' } });
      return;
    }
    if (cur.classList.contains('disabled')) {
      sfx.error();
      return;
    }
    act(id);
  }

  const off = on('capture-state', (s) => {
    st = s || {};
    render();
  });
  timer = setInterval(() => st.recording && render(), 500);

  const ctl = mountOverlay(
    root,
    (action) => {
      if (action === 'left' || action === 'right') {
        if (nav.move(action === 'left' ? -1 : 1)) sfx.move();
        else sfx.bump();
      } else if (action === 'confirm') choose();
      else if (action === 'back' || action === 'select' || action === 'guide') {
        sfx.back();
        ctl.close();
      }
      return true;
    },
    {
      closeDelay: 260,
      onClose: () => {
        clearInterval(timer);
        off && off();
        onClosed && onClosed();
      },
    }
  );
  sfx.menuIn ? sfx.menuIn() : sfx.open();
  render();
  loadLatest();
  return ctl;
}
