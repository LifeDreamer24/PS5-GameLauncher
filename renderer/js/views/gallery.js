// Media Gallery: the clips, recordings and screenshots saved through the
// capture menu (and anything else in the captures folder). A grid like the
// PS5's, a full-screen viewer, and Delete / Show in Folder.

import { h, escapeHtml, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { api, state } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { mountOverlay, FocusList } from '../ui/overlay.js';
import { optionsMenu, confirmDialog } from '../ui/dialogs.js';
import { renderHints } from '../ui/glyphs.js';
import { t } from '../i18n.js';

const COLS = 4;
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Video Clips' },
  { id: 'image', label: 'Screenshots' },
];
const url = (u) => (window.appUrl ? window.appUrl(u) : u);
// Rounded down, like the video player's own time display.
const fmtDuration = (s) => {
  const n = Math.floor(Number(s) || 0);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

function previewHtml(c) {
  if (c.kind === 'image') return `<img src="${escapeHtml(url(c.url))}" alt="" loading="lazy">`;
  if (c.thumbUrl) return `<img src="${escapeHtml(url(c.thumbUrl))}" alt="" loading="lazy">`;
  // No saved thumbnail: the browser shows the video's first frame.
  return `<video src="${escapeHtml(url(c.url))}#t=0.5" preload="metadata" muted></video>`;
}

export function openGallery() {
  let all = [];
  let tab = 'all';
  let game = null;
  let loading = true;

  const tabs = TABS.map((x) => h('button', { class: 'ss-tab', text: t(x.label), onclick: () => switchTab(x.id) }));
  const status = h('div', { class: 'ss-status' });
  const grid = h('div', { class: 'ss-grid gal-grid' });
  const scroller = h('div', { class: 'ss-scroll' }, grid);
  const hints = h('div', { class: 'ss-hints' });
  renderHints(hints, [
    ['confirm', 'View'],
    ['y', 'Filter'],
    ['options', 'Options'],
    ['l1', 'Switch Tabs'],
    ['back', 'Close'],
  ]);
  const root = h(
    'div',
    { class: 'overlay sound-store gallery' },
    h(
      'div',
      { class: 'ss-panel' },
      h('div', { class: 'ss-head' }, h('div', { class: 'ss-title', text: t('Media Gallery') }), h('div', { class: 'ss-tabs' }, ...tabs), status),
      scroller,
      h('div', { class: 'ss-foot' }, h('div', { class: 'ss-credit', text: '' }), hints)
    )
  );
  let nav = new FocusList([]);

  const shown = () => all.filter((c) => (tab === 'all' || c.kind === tab) && (!game || c.game === game));

  function reveal(el) {
    if (!el) return;
    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 28;
    const top = r.top - box.top + scroller.scrollTop;
    if (nav.index < COLS) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    else if (top < scroller.scrollTop + pad) scroller.scrollTo({ top: top - pad, behavior: 'smooth' });
    else if (top + r.height > scroller.scrollTop + scroller.clientHeight - pad) scroller.scrollTo({ top: top + r.height - scroller.clientHeight + pad, behavior: 'smooth' });
  }

  function render(keep = false) {
    const index = keep ? nav.index : 0;
    const list = shown();
    grid.innerHTML = '';
    const els = list.map((c, i) => {
      const badge = c.kind === 'video' ? `<span class="gal-badge">${icon('play')}${c.seconds ? fmtDuration(c.seconds) : ''}</span>` : '';
      const el = h('button', {
        class: 'ss-card gal-card fx',
        html: `
          <div class="ss-img gal-img">${previewHtml(c)}${badge}</div>
          <div class="ss-name">${escapeHtml(c.game || t('Captures'))}</div>
          <div class="ss-meta"><span>${escapeHtml(timeAgo(c.time))}</span><span>${t(c.type === 'clip' ? 'Clip' : c.kind === 'image' ? 'Screenshot' : 'Recording')}</span></div>`,
      });
      el.addEventListener('mouseenter', () => mouseActive() && nav.set(i));
      el.addEventListener('click', () => {
        nav.set(i);
        view(i);
      });
      return el;
    });
    grid.append(...els);
    nav = new FocusList(els, { index: Math.max(0, Math.min(index, els.length - 1)), onChange: (el) => reveal(el) });
    tabs.forEach((b, i) => b.classList.toggle('active', TABS[i].id === tab));
    status.textContent = loading ? t('Loading…') : `${game ? `${game} · ` : ''}${t(list.length === 1 ? '1 item' : '{n} items', { n: list.length })}`;
    if (!loading && !list.length) {
      const off = state.settings.captureEnabled === false || !state.settings.captureEnabled;
      grid.append(
        h('div', {
          class: 'ss-empty',
          text: t(off ? 'No captures yet. Turn on recording in Settings › Captures, then press the Create button in a game.' : 'No captures yet. Press the Create button in a game to save clips and screenshots.'),
        })
      );
    }
  }

  async function load(keep = false) {
    try {
      all = await api.captureList();
    } catch {
      all = [];
    }
    loading = false;
    render(keep);
  }

  function switchTab(id) {
    if (id === tab) return;
    tab = id;
    sfx.tab();
    render();
  }

  async function chooseGame() {
    const games = [...new Set(all.map((c) => c.game).filter(Boolean))].sort();
    const choice = await optionsMenu({
      title: 'Show Captures From',
      items: [{ label: 'All Games', value: null, checked: !game }, ...games.map((g) => ({ label: g, value: g, checked: g === game }))],
    });
    if (!choice) return;
    game = choice.value;
    render();
  }

  async function remove(c) {
    const ok = await confirmDialog({
      title: t(c.kind === 'image' ? 'Delete this screenshot?' : 'Delete this video?'),
      message: 'It goes to the Recycle Bin.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.captureDelete(c.file);
      sfx.select();
    } catch {
      sfx.error();
    }
    await load(true);
    return true;
  }

  async function itemMenu(c, anchor) {
    await optionsMenu({
      title: c.game || 'Captures',
      anchor,
      items: [
        { label: 'Show in Folder', icon: 'folder', run: () => api.captureReveal(c.file) },
        { label: 'Delete', icon: 'trash', danger: true, run: () => remove(c) },
      ],
    });
  }

  /* ---------------- Viewer ---------------- */

  function view(start) {
    let i = start;
    const list = shown();
    if (!list[i]) return;
    sfx.select();
    let full = false;
    let idleTimer = null;
    let osdTimer = null;
    const media = h('div', { class: 'gv-media' });
    const osd = h('div', { class: 'gv-osd' });
    const stage = h('div', { class: 'gv-stage' }, media, osd);
    const title = h('div', { class: 'gv-title' });
    const vhints = h('div', { class: 'ss-hints gv-hints' });
    const box = h('div', { class: 'overlay gallery-viewer' }, stage, h('div', { class: 'gv-bar' }, title, vhints));

    function hints() {
      const c = list[i];
      const video = c.kind === 'video';
      renderHints(vhints, [
        ...(video ? [['confirm', 'Play / Pause'], ['l1', '-5 s'], ['r1', '+5 s']] : []),
        ['adjust', 'Previous / Next'],
        ['y', full ? 'Exit Full Screen' : 'Full Screen'],
        ['options', 'Options'],
        ...(full ? [] : [['back', 'Close']]), // in full screen, back leaves full screen (shown on the y hint)
      ]);
    }

    function show() {
      const c = list[i];
      media.innerHTML = '';
      if (c.kind === 'image') media.append(h('img', { src: url(c.url), alt: '' }));
      else media.append(h('video', { src: url(c.url), controls: !full, autoplay: true }));
      title.innerHTML = `<b>${escapeHtml(c.game || t('Captures'))}</b><span>${escapeHtml(new Date(c.time).toLocaleString())} · ${i + 1} / ${list.length}</span>`;
      hints();
    }

    /** In full screen the bar fades out after a moment and comes back on any input. */
    function wake() {
      box.classList.remove('idle');
      clearTimeout(idleTimer);
      if (full) idleTimer = setTimeout(() => box.classList.add('idle'), 2600);
    }

    function setFull(on) {
      full = on;
      box.classList.toggle('full', full);
      const v = media.querySelector('video');
      if (v) v.controls = !full;
      sfx.select();
      hints();
      wake();
    }

    function seek(delta) {
      const v = media.querySelector('video');
      if (!v || !Number.isFinite(v.duration)) return sfx.bump();
      v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
      sfx.move();
      osd.textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta)} s · ${fmtDuration(v.currentTime)} / ${fmtDuration(v.duration)}`;
      osd.classList.add('show');
      clearTimeout(osdTimer);
      osdTimer = setTimeout(() => osd.classList.remove('show'), 1100);
    }

    box.addEventListener('mousemove', wake);

    const vctl = mountOverlay(box, (action) => {
      const video = media.querySelector('video');
      wake();
      if (action === 'back' && full) setFull(false);
      else if (action === 'back') {
        sfx.back();
        vctl.close();
      } else if (action === 'y') setFull(!full);
      else if (action === 'l1' || action === 'r1') {
        if (video) seek(action === 'l1' ? -5 : 5);
        else sfx.bump();
      } else if (action === 'left' || action === 'right') {
        const to = i + (action === 'left' ? -1 : 1);
        if (to >= 0 && to < list.length) {
          i = to;
          sfx.move();
          show();
          nav.set(i);
        } else sfx.bump();
      } else if (action === 'confirm' && video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      } else if (action === 'options') {
        const c = list[i];
        optionsMenu({
          title: c.game || 'Captures',
          items: [
            { label: 'Show in Folder', icon: 'folder', run: () => api.captureReveal(c.file) },
            {
              label: 'Delete',
              icon: 'trash',
              danger: true,
              run: async () => {
                const v = stage.querySelector('video');
                if (v) v.pause();
                if (await remove(c)) vctl.close();
              },
            },
          ],
        });
      }
      return true;
    }, {
      closeDelay: 220,
      onClose: () => {
        clearTimeout(idleTimer);
        clearTimeout(osdTimer);
        stage.querySelectorAll('video').forEach((v) => v.pause());
      },
    });
    show();
  }

  const ctl = mountOverlay(root, (action) => {
    if (action === 'back') {
      sfx.back();
      ctl.close();
    } else if (action === 'left' || action === 'right') {
      if (nav.move(action === 'left' ? -1 : 1)) sfx.move();
      else sfx.bump();
    } else if (action === 'up' || action === 'down') {
      const to = nav.index + (action === 'up' ? -COLS : COLS);
      if (to >= 0 && to < nav.els.length && nav.set(to)) sfx.move();
      else if (action === 'down' && nav.index < nav.els.length - 1 && nav.set(nav.els.length - 1)) sfx.move();
      else sfx.bump();
    } else if (action === 'confirm') view(nav.index);
    else if (action === 'y') chooseGame();
    else if (action === 'options' || action === 'x') {
      const c = shown()[nav.index];
      if (c) itemMenu(c, nav.current);
    } else if (action === 'l1' || action === 'r1') {
      const k = TABS.findIndex((x) => x.id === tab) + (action === 'l1' ? -1 : 1);
      if (k >= 0 && k < TABS.length) switchTab(TABS[k].id);
      else sfx.bump();
    }
    return true;
  }, { closeDelay: 320 });
  sfx.open();
  render();
  load();
  return ctl;
}
