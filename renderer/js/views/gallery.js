// Media Gallery: the clips, recordings and screenshots saved through the
// capture menu (and anything else in the captures folder), laid out like the
// PS5's: the Game Library's header and tabs (All, Favorites, Albums), a round
// sort / filter button with a "select media" button under it, and a grid of
// 16:9 thumbnails. Sort by date or size, filter by video clips / screenshots,
// and Select Media to delete several at once. A full-screen viewer plays them.

import { h, escapeHtml, timeAgo, bump, clamp, fmtBytes } from '../util.js';
import { icon } from '../icons.js';
import { api, state, on } from '../state.js';
import { sfx } from '../sound.js';
import { rumble, mouseActive } from '../input.js';
import { mountOverlay, FocusList } from '../ui/overlay.js';
import { optionsMenu, confirmDialog, filterPanel, checkMenu } from '../ui/dialogs.js';
import { renderHints } from '../ui/glyphs.js';
import { t } from '../i18n.js';
import { showFolder } from '../ui/filebrowser.js';

const COLS = 3;
const TABS = [
  { key: 'all', label: 'All' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'albums', label: 'Albums' },
];
const SORTS = [
  { value: 'date', label: 'Date' },
  { value: 'size', label: 'Size' },
];
const KINDS = [
  { value: 'video', label: 'Video Clips' },
  { value: 'image', label: 'Screenshots' },
];

const url = (u) => (window.appUrl ? window.appUrl(u) : u);
// Rounded down, like the video player's own time display.
const fmtDuration = (s) => {
  const n = Math.floor(Number(s) || 0);
  const m = Math.floor(n / 60);
  return `${String(m).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

function previewHtml(c) {
  if (c.kind === 'image') return `<img src="${escapeHtml(url(c.url))}" alt="" loading="lazy" decoding="async">`;
  if (c.thumbUrl) return `<img src="${escapeHtml(url(c.thumbUrl))}" alt="" loading="lazy" decoding="async">`;
  // No saved thumbnail: the browser shows the video's first frame.
  return `<video src="${escapeHtml(url(c.url))}#t=0.5" preload="metadata" muted></video>`;
}

let galleryRouter = null;

/** Open the Media Gallery (Settings › Captures, the capture menu…). */
export function openGallery(params = {}) {
  if (galleryRouter) galleryRouter.open('gallery', params);
}

export class GalleryView {
  constructor(router) {
    this.router = router;
    galleryRouter = router;
    this.name = 'gallery';
    this.usesHero = false;
    this.tab = 'all';
    this.album = null; // a game's album, opened from Albums
    this.sort = 'date';
    this.kinds = new Set(); // empty: everything
    this.zone = 'grid';
    this.sideIndex = 0;
    this.all = [];
    this.items = [];
    this.loading = true;
    this.build();
    // A clip or screenshot saved while the gallery is open shows up right away.
    on('notifications', (n) => n && n.kind === 'capture' && this.active && setTimeout(() => this.load(true), 400));
  }

  build() {
    this.tabEls = TABS.map((tab, i) =>
      h('button', {
        class: 'lib-tab fx',
        text: t(tab.label),
        onclick: () => {
          this.setZone('tabs', i, true);
          this.setTab(tab.key);
        },
        onmouseenter: () => mouseActive() && this.setZone('tabs', i, true),
      })
    );
    this.tabNav = new FocusList(this.tabEls);
    this.sideEls = [
      h('button', { class: 'lib-filter gal-side fx', title: t('Sort and Filter'), html: icon('sort') }),
      h('button', { class: 'lib-filter gal-side gal-select fx', title: t('Select Media'), html: icon('selectMedia') }),
    ];
    this.sideEls.forEach((el, i) => {
      el.addEventListener('click', () => {
        this.setZone('side', i, true);
        this.activateSide();
      });
      el.addEventListener('mouseenter', () => mouseActive() && this.setZone('side', i, true));
    });
    this.sortLabel = h('div', { class: 'gal-sortlabel' });
    this.albumTitle = h('div', { class: 'gal-album-title' });
    this.grid = h('div', { class: 'gal-grid lib-grid' });
    this.gridWrap = h('div', { class: 'lib-grid-wrap gal-grid-wrap' }, this.grid);
    this.empty = h('div', { class: 'lib-empty gal-empty' });
    this.gridWrap.addEventListener(
      'wheel',
      (e) => {
        const now = performance.now();
        if (now - (this.lastWheel || 0) < 90) return;
        this.lastWheel = now;
        this.setZone('grid', null, true);
        this.moveGrid(e.deltaY > 0 ? COLS : -COLS, true);
      },
      { passive: true }
    );
    this.hints = h('div', { class: 'gal-hints' });
    this.el = h(
      'section',
      { class: 'view lib-view gal-view' },
      h('header', { class: 'lib-header' }, h('div', { class: 'lib-badge', html: icon('gallery') }), h('div', { class: 'lib-title', text: t('Media Gallery') })),
      h('nav', { class: 'lib-tabs' }, ...this.tabEls),
      this.sideEls[0],
      this.sideEls[1],
      this.albumTitle,
      this.sortLabel,
      this.gridWrap,
      this.empty,
      this.hints
    );
  }

  /* ---------------------------------------------------------------- */
  /* Data                                                              */
  /* ---------------------------------------------------------------- */

  async load(keep = false) {
    try {
      this.all = await api.captureList();
    } catch {
      this.all = [];
    }
    this.loading = false;
    if (this.active) this.render(keep);
  }

  /** Captures passing the media filter, sorted. */
  filtered(list = this.all) {
    const out = list.filter((c) => !this.kinds.size || this.kinds.has(c.kind));
    if (this.sort === 'size') out.sort((a, b) => (b.size || 0) - (a.size || 0) || b.time - a.time);
    else out.sort((a, b) => b.time - a.time);
    return out;
  }

  /** What the grid shows: captures, or the albums (one per game). */
  list() {
    if (this.tab === 'favorites') return this.filtered(this.all.filter((c) => c.favorite));
    if (this.tab === 'albums' && this.album !== null) return this.filtered(this.all.filter((c) => (c.game || '') === this.album));
    if (this.tab === 'albums') {
      const albums = new Map();
      for (const c of this.filtered()) {
        const key = c.game || '';
        if (!albums.has(key)) albums.set(key, { album: key, items: [] });
        albums.get(key).items.push(c);
      }
      return [...albums.values()].sort((a, b) => b.items[0].time - a.items[0].time);
    }
    return this.filtered();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  render(keep = false) {
    const prev = keep && this.items[this.gridIndex] ? this.keyOf(this.items[this.gridIndex]) : null;
    this.items = this.list();
    this.tabEls.forEach((el, i) => el.classList.toggle('active', TABS[i].key === this.tab));
    this.sideEls[0].classList.toggle('filtered', this.kinds.size > 0);
    this.sortLabel.textContent = `${t('Sort by:')} ${t(SORTS.find((s) => s.value === this.sort).label)}`;
    const inAlbum = this.tab === 'albums' && this.album !== null;
    this.el.classList.toggle('in-album', inAlbum);
    this.albumTitle.textContent = inAlbum ? this.album || t('Captures') : '';

    this.tileEls = this.items.map((it, i) => {
      const el = it.album !== undefined ? this.albumTile(it) : this.captureTile(it);
      el.style.setProperty('--i', Math.min(i, 12));
      el.addEventListener('click', () => {
        this.setZone('grid', null, true);
        this.gridNav.set(i);
        this.open(i);
      });
      el.addEventListener('mouseenter', () => {
        if (!mouseActive()) return;
        this.setZone('grid', null, true);
        this.gridNav.set(i);
      });
      return el;
    });
    this.grid.replaceChildren(...this.tileEls);
    if (!keep) {
      this.grid.classList.remove('stagger');
      void this.grid.offsetWidth;
      this.grid.classList.add('stagger');
    }
    let idx = prev ? this.items.findIndex((it) => this.keyOf(it) === prev) : 0;
    if (idx < 0) idx = clamp(this.gridIndex || 0, 0, Math.max(0, this.items.length - 1));
    this.gridNav = new FocusList(this.tileEls, { index: idx, onChange: () => this.scrollToFocus() });
    if (!this.items.length && this.zone === 'grid' && !this.loading) this.zone = 'tabs';

    const n = this.items.length;
    this.empty.style.display = n || this.loading ? 'none' : '';
    if (!n && !this.loading) {
      const off = !state.settings.captureEnabled;
      const filteredOut = this.all.length && this.kinds.size;
      this.empty.innerHTML = `<div class="le-icon">${icon(this.tab === 'favorites' ? 'star' : 'gallery')}</div>
        <div class="le-title">${escapeHtml(t(filteredOut ? 'Nothing matches the filter' : this.tab === 'favorites' ? 'No favorites yet' : 'No captures yet'))}</div>
        <div class="le-text">${escapeHtml(
          t(
            filteredOut
              ? 'Change the filter with the sort button, or reset it.'
              : this.tab === 'favorites'
                ? 'Press Options on any capture and add it to your favorites.'
                : off
                  ? 'Turn on recording in Settings › Captures, then press the Create button in a game.'
                  : 'Press the Create button in a game to save clips and screenshots.'
          )
        )}</div>`;
    }
    this.renderHints();
    this.scrollToFocus(true);
    this.applyZone();
  }

  keyOf(it) {
    return it.album !== undefined ? `album:${it.album}` : it.file;
  }

  captureTile(c) {
    const video = c.kind === 'video';
    return h('button', {
      class: 'gal-tile fx',
      html: `<div class="gt-art">${previewHtml(c)}
        ${video && c.seconds ? `<span class="gt-dur">${fmtDuration(c.seconds)}</span>` : ''}
        ${video ? `<span class="gt-play">${icon('playSolid')}</span>` : ''}
        ${c.favorite ? `<span class="gt-fav">${icon('starFill')}</span>` : ''}
        <div class="gt-info"><span class="gt-game">${escapeHtml(c.game || t('Captures'))}</span><span class="gt-meta">${escapeHtml(
          [timeAgo(c.time), this.sort === 'size' && c.size ? fmtBytes(c.size) : ''].filter(Boolean).join(' · ')
        )}</span></div>
      </div>`,
    });
  }

  albumTile(a) {
    const n = a.items.length;
    return h('button', {
      class: 'gal-tile gal-album fx',
      html: `<div class="gt-art">${previewHtml(a.items[0])}
        <div class="gt-info always"><span class="gt-game">${escapeHtml(a.album || t('Captures'))}</span><span class="gt-meta">${escapeHtml(
          t(n === 1 ? '1 item' : '{n} items', { n })
        )}</span></div>
      </div>`,
    });
  }

  renderHints() {
    const it = this.items[this.gridIndex];
    renderHints(this.hints, [
      ['confirm', it && it.album !== undefined ? 'Open' : 'View'],
      ['options', 'Options'],
      ['l1', 'Switch Tabs'],
      ['back', this.album !== null && this.tab === 'albums' ? 'Albums' : 'Back'],
    ]);
  }

  get gridIndex() {
    return this.gridNav ? this.gridNav.index : 0;
  }

  scrollToFocus(instant = false) {
    const el = this.gridNav && this.gridNav.current;
    if (!el) {
      this.grid.style.transform = '';
      return;
    }
    const row = Math.floor(this.gridNav.index / COLS);
    const rowH = el.offsetHeight + parseFloat(getComputedStyle(this.grid).rowGap || 0);
    const offset = Math.max(0, row - 1) * rowH;
    if (instant) this.grid.style.transition = 'none';
    this.grid.style.transform = `translateY(${-offset}px)`;
    this.el.classList.toggle('grid-scrolled', offset > 0);
    if (instant) {
      void this.grid.offsetWidth;
      this.grid.style.transition = '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Focus                                                             */
  /* ---------------------------------------------------------------- */

  setTab(key) {
    if (key === this.tab && this.album === null) return;
    this.tab = key;
    this.album = null;
    sfx.select();
    this.gridNav = null;
    this.render();
  }

  setZone(zone, index = null, silent = false) {
    if (zone === 'grid' && !this.items.length) return;
    const changed = zone !== this.zone;
    this.zone = zone;
    if (index !== null && zone === 'tabs') this.tabNav.set(index, { silent: true });
    if (index !== null && zone === 'side') this.sideIndex = index;
    if (changed && !silent) sfx.move();
    this.applyZone();
  }

  applyZone() {
    this.tabNav.blur();
    this.sideEls.forEach((el, i) => el.classList.toggle('focused', this.zone === 'side' && i === this.sideIndex));
    if (this.gridNav) this.gridNav.blur();
    if (this.zone === 'tabs') this.tabNav.refocus();
    else if (this.zone === 'grid' && this.gridNav) this.gridNav.refocus();
    this.renderHints();
  }

  focusActiveTab() {
    this.tabNav.set(
      TABS.findIndex((x) => x.key === this.tab),
      { silent: true }
    );
    this.setZone('tabs');
  }

  moveGrid(delta, fromWheel = false) {
    const n = this.items.length;
    const i = this.gridIndex;
    let ni = i + delta;
    if (delta === -1 && i % COLS === 0) {
      if (!fromWheel) this.setZone('side');
      return;
    }
    if (Math.abs(delta) === 1 && Math.floor(ni / COLS) !== Math.floor(i / COLS)) ni = -1;
    if (delta > 1 && ni >= n && Math.floor(i / COLS) < Math.floor((n - 1) / COLS)) ni = n - 1;
    if (ni < 0 || ni >= n) {
      if (delta === -COLS && !fromWheel) {
        this.focusActiveTab();
        return;
      }
      if (!fromWheel) {
        sfx.bump();
        rumble(0.3);
        bump(this.gridNav.current, delta === 1 ? 'right' : delta === -1 ? 'left' : delta > 0 ? 'down' : 'up');
      }
      return;
    }
    this.gridNav.set(ni);
    sfx.move();
    this.renderHints();
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  open(i) {
    const it = this.items[i];
    if (!it) return;
    if (it.album !== undefined) {
      sfx.select();
      this.album = it.album;
      this.gridNav = null;
      this.render();
      return;
    }
    openViewer(this.items, i, {
      onMove: (k) => this.gridNav && this.gridNav.set(k, { silent: true }),
      onChange: () => this.load(true),
    });
  }

  activateSide() {
    if (this.sideIndex === 0) this.openFilters();
    else this.selectMedia();
  }

  async openFilters() {
    sfx.select();
    const kindsText = () => (this.kinds.size === 1 ? KINDS.find((k) => this.kinds.has(k.value)).label : '');
    await filterPanel({
      anchor: this.sideEls[0],
      rows: () => [
        {
          type: 'value',
          label: 'Sort by',
          value: () => SORTS.find((s) => s.value === this.sort).label,
          run: async (el) => {
            const choice = await optionsMenu({ anchor: el, index: SORTS.findIndex((s) => s.value === this.sort), items: SORTS.map((s) => ({ ...s, checked: s.value === this.sort })) });
            if (choice && choice.value !== this.sort) {
              this.sort = choice.value;
              this.render();
            }
          },
        },
        { type: 'divider' },
        { type: 'header', label: 'Filters' },
        {
          type: 'value',
          label: 'Media',
          value: kindsText,
          run: (el) =>
            checkMenu({
              anchor: el,
              items: KINDS.map((k) => ({ ...k, checked: this.kinds.has(k.value) })),
              onChange: (items) => {
                this.kinds = new Set(items.filter((x) => x.checked).map((x) => x.value));
                if (this.kinds.size === KINDS.length) this.kinds = new Set(); // both: no filter
                this.render();
              },
            }),
        },
        {
          type: 'button',
          label: 'Reset Filters',
          disabled: () => !this.kinds.size,
          run: () => {
            this.kinds = new Set();
            this.render();
          },
        },
      ],
    });
  }

  async selectMedia() {
    const list = this.tab === 'albums' && this.album === null ? this.filtered() : this.items;
    if (!list.length) {
      sfx.bump();
      return;
    }
    sfx.select();
    if (await openSelect(list)) await this.load(true);
  }

  async itemMenu(c, anchor) {
    if (!c || c.album !== undefined) return;
    await optionsMenu({
      title: c.game || 'Captures',
      anchor,
      items: [
        {
          label: c.favorite ? 'Remove from Favorites' : 'Add to Favorites',
          icon: c.favorite ? 'starFill' : 'star',
          run: async () => {
            await api.captureFavorite(c.file, !c.favorite).catch(() => {});
            await this.load(true);
          },
        },
        { label: 'Show in Folder', icon: 'folder', run: async () => showFolder('Captures', await api.captureDir(), c.file) },
        {
          label: 'Delete',
          icon: 'trash',
          danger: true,
          run: async () => {
            if (await removeCapture(c)) await this.load(true);
          },
        },
      ],
    });
  }

  handle(action) {
    if (action === 'l1' || action === 'r1') {
      const k = TABS.findIndex((x) => x.key === this.tab) + (action === 'l1' ? -1 : 1);
      if (k >= 0 && k < TABS.length) {
        this.tabNav.set(k, { silent: true });
        this.setTab(TABS[k].key);
      } else sfx.bump();
      return true;
    }
    if (action === 'back' && this.tab === 'albums' && this.album !== null) {
      // Out of an album, back to the albums.
      const was = this.album;
      sfx.back();
      this.album = null;
      this.gridNav = null;
      this.render();
      const i = this.items.findIndex((a) => a.album === was);
      if (i >= 0) this.gridNav.set(i, { silent: true });
      this.scrollToFocus(true);
      this.setZone('grid', null, true);
      return true;
    }
    if (this.zone === 'tabs') {
      if (action === 'left' || action === 'right') {
        const ni = this.tabNav.index + (action === 'left' ? -1 : 1);
        if (ni >= 0 && ni < TABS.length) {
          this.tabNav.set(ni);
          sfx.move();
          this.setTab(TABS[ni].key);
        } else sfx.bump();
      } else if (action === 'confirm') this.setTab(TABS[this.tabNav.index].key);
      else if (action === 'down') this.setZone(this.items.length ? 'grid' : 'side', this.items.length ? null : 0);
      else if (action === 'up') sfx.bump();
      else return false;
      return true;
    }
    if (this.zone === 'side') {
      if (action === 'confirm') this.activateSide();
      else if (action === 'down') {
        if (this.sideIndex < this.sideEls.length - 1) {
          this.sideIndex++;
          sfx.move();
          this.applyZone();
        } else sfx.bump();
      } else if (action === 'up') {
        if (this.sideIndex > 0) {
          this.sideIndex--;
          sfx.move();
          this.applyZone();
        } else this.focusActiveTab();
      } else if (action === 'right') {
        if (this.items.length) {
          const row = Math.floor(this.gridIndex / COLS);
          this.gridNav.set(Math.min(row * COLS, this.items.length - 1), { silent: true });
          this.setZone('grid');
        } else sfx.bump();
      } else if (action === 'left') sfx.bump();
      else return false;
      return true;
    }
    const it = this.items[this.gridIndex];
    switch (action) {
      case 'left':
        this.moveGrid(-1);
        return true;
      case 'right':
        this.moveGrid(1);
        return true;
      case 'up':
        this.moveGrid(-COLS);
        return true;
      case 'down':
        this.moveGrid(COLS);
        return true;
      case 'confirm':
        this.open(this.gridIndex);
        return true;
      case 'options':
      case 'x':
        if (it && it.album === undefined) this.itemMenu(it, this.gridNav.current);
        else sfx.bump();
        return true;
    }
    return false;
  }

  show(params = {}, dir) {
    this.active = true;
    const keep = dir === 'back' || dir === 'same';
    if (!keep) {
      this.zone = 'grid';
      this.gridNav = null;
      if (params.tab) this.tab = params.tab;
    }
    this.render(keep);
    this.load(keep);
  }

  hide() {
    this.active = false;
  }
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

async function removeCapture(c) {
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
  return true;
}

/* ------------------------------------------------------------------ */
/* Select Media: tick several, then delete them                        */
/* ------------------------------------------------------------------ */

function openSelect(list) {
  return new Promise((resolve) => {
    const picked = new Set();
    const tiles = list.map((c, i) => {
      const video = c.kind === 'video';
      const el = h('button', {
        class: 'gal-tile sel-tile fx',
        html: `<div class="gt-art">${previewHtml(c)}
          <span class="gt-check">${icon('check')}</span>
          ${video && c.seconds ? `<span class="gt-dur">${fmtDuration(c.seconds)}</span>` : ''}
          ${video ? `<span class="gt-play">${icon('playSolid')}</span>` : ''}
        </div>`,
      });
      el.addEventListener('mouseenter', () => mouseActive() && focus('grid', i));
      el.addEventListener('click', () => {
        focus('grid', i);
        toggle(i);
      });
      return el;
    });
    const grid = h('div', { class: 'sel-grid' }, ...tiles);
    const wrap = h('div', { class: 'sel-grid-wrap' }, grid);
    const count = h('div', { class: 'sel-count' });
    const btnDefs = [
      { label: 'Select All', run: () => setAll(true) },
      { label: 'Deselect All', run: () => setAll(false), disabled: () => !picked.size },
      { label: 'Delete', run: () => remove(), disabled: () => !picked.size },
    ];
    const btns = btnDefs.map((b, i) => {
      const el = h('button', { class: 'sel-btn fx', text: t(b.label) });
      el.addEventListener('mouseenter', () => mouseActive() && !el.classList.contains('disabled') && focus('btns', i));
      el.addEventListener('click', () => {
        focus('btns', i);
        press();
      });
      return el;
    });
    const hints = h('div', { class: 'gal-hints' });
    renderHints(hints, [
      ['confirm', 'Select'],
      ['back', 'Cancel'],
    ]);
    const root = h(
      'div',
      { class: 'overlay sel-overlay' },
      h('div', { class: 'sel-title', text: t('Select Media') }),
      wrap,
      h('div', { class: 'sel-side' }, btns[0], btns[1], count, btns[2]),
      hints
    );
    const gridNav = new FocusList(tiles, { onChange: () => scroll() });
    const btnNav = new FocusList(btns);
    let zone = 'btns';
    let done = false;

    function paint() {
      tiles.forEach((el, i) => el.classList.toggle('on', picked.has(i)));
      count.textContent = t('{n} Selected', { n: picked.size });
      btns.forEach((el, i) => el.classList.toggle('disabled', !!(btnDefs[i].disabled && btnDefs[i].disabled())));
      if (zone === 'btns' && btns[btnNav.index].classList.contains('disabled')) btnNav.set(0, { silent: true });
      applyZone();
    }
    function applyZone() {
      gridNav.blur();
      btnNav.blur();
      (zone === 'grid' ? gridNav : btnNav).refocus();
    }
    function focus(z, i) {
      zone = z;
      (z === 'grid' ? gridNav : btnNav).set(i, { silent: true });
      applyZone();
    }
    function scroll() {
      const el = gridNav.current;
      if (!el) return;
      const row = Math.floor(gridNav.index / COLS);
      const rowH = el.offsetHeight + parseFloat(getComputedStyle(grid).rowGap || 0);
      grid.style.transform = `translateY(${-Math.max(0, row - 1) * rowH}px)`;
    }
    function toggle(i) {
      if (picked.has(i)) picked.delete(i);
      else picked.add(i);
      sfx.toggle(picked.has(i));
      paint();
    }
    function setAll(on) {
      if (on) list.forEach((_, i) => picked.add(i));
      else picked.clear();
      paint();
    }
    function press() {
      const b = btnDefs[btnNav.index];
      if (!b || btns[btnNav.index].classList.contains('disabled')) return sfx.bump();
      sfx.select();
      b.run();
    }
    async function remove() {
      const n = picked.size;
      const ok = await confirmDialog({
        title: t(n === 1 ? 'Delete 1 item?' : 'Delete {n} items?', { n }),
        message: 'They go to the Recycle Bin.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.captureDelete([...picked].map((i) => list[i].file));
      } catch {
        sfx.error();
      }
      close(true);
    }
    function close(changed) {
      if (done) return;
      done = true;
      ctl.close();
      resolve(changed);
    }

    const ctl = mountOverlay(root, (action) => {
      if (action === 'back') {
        sfx.back();
        close(false);
      } else if (zone === 'btns') {
        if (action === 'up' || action === 'down') btnNav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
        else if (action === 'left') {
          // Back to the grid, on the row that is in view.
          zone = 'grid';
          if (gridNav.index < 0) gridNav.set(0, { silent: true });
          sfx.move();
          applyZone();
        } else if (action === 'confirm') press();
        else sfx.bump();
      } else {
        const i = gridNav.index;
        if (action === 'confirm') toggle(i);
        else if (action === 'left' || action === 'right') {
          const ni = i + (action === 'left' ? -1 : 1);
          if (action === 'right' && (i % COLS === COLS - 1 || ni >= list.length)) {
            zone = 'btns';
            sfx.move();
            applyZone();
          } else if (action === 'left' && i % COLS === 0) sfx.bump();
          else if (gridNav.set(ni)) sfx.move();
        } else if (action === 'up' || action === 'down') {
          const ni = i + (action === 'up' ? -COLS : COLS);
          if (ni >= 0 && ni < list.length && gridNav.set(ni)) sfx.move();
          else if (action === 'down' && Math.floor(i / COLS) < Math.floor((list.length - 1) / COLS) && gridNav.set(list.length - 1)) sfx.move();
          else sfx.bump();
        }
      }
      return true;
    }, { closeDelay: 260 });
    sfx.open();
    zone = 'grid';
    gridNav.set(0, { silent: true });
    paint();
  });
}

/* ------------------------------------------------------------------ */
/* Viewer                                                              */
/* ------------------------------------------------------------------ */

function openViewer(list, start, { onMove, onChange } = {}) {
  let i = start;
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
      ...(full ? [] : [['back', 'Close']]), // in full screen, back leaves full screen (shown on the y hint)
    ]);
  }

  function show() {
    const c = list[i];
    media.innerHTML = '';
    if (c.kind === 'image') media.append(h('img', { src: url(c.url), alt: '' }));
    else media.append(h('video', { src: url(c.url), controls: !full, autoplay: true }));
    title.innerHTML = `<b>${escapeHtml(c.game || t('Captures'))}${c.favorite ? ` ${icon('starFill')}` : ''}</b><span>${escapeHtml(new Date(c.time).toLocaleString())} · ${i + 1} / ${list.length}</span>`;
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

  const vctl = mountOverlay(
    box,
    (action) => {
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
          onMove && onMove(i);
        } else sfx.bump();
      } else if (action === 'confirm' && video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      } else if (action === 'options') {
        // Not while looking at a capture: Favorite, Show in Folder and Delete are in the gallery's Options.
        sfx.bump();
      }
      return true;
    },
    {
      closeDelay: 220,
      onClose: () => {
        clearTimeout(idleTimer);
        clearTimeout(osdTimer);
        stage.querySelectorAll('video').forEach((v) => v.pause());
      },
    }
  );
  show();
}
