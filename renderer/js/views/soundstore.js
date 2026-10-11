// Sound theme store: browse deckthemes.com audio and music packs, download
// and use them. Also the place to switch between installed packs.

import { h, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { api, state, setSetting, pushNotification, emit } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { mountOverlay, FocusList } from '../ui/overlay.js';
import { optionsMenu, textDialog } from '../ui/dialogs.js';
import { renderHints } from '../ui/glyphs.js';
import { t } from '../i18n.js';

const COLS = 4;
const ORDERS = ['Most Downloaded', 'Most Stars', 'Last Updated', 'Alphabetical (A to Z)'];
const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export function openSoundStore({ kind = 'Audio' } = {}) {
  let tab = kind === 'Music' ? 'Music' : 'Audio';
  let order = ORDERS[0];
  let search = '';
  let page = 1;
  let total = 0;
  let items = [];
  let installed = [];
  let loading = false;
  let busyId = null;

  const tabs = ['Audio', 'Music'].map((k) => h('button', { class: 'ss-tab', text: t(k === 'Audio' ? 'UI Sounds' : 'Menu Music'), onclick: () => switchTab(k) }));
  const status = h('div', { class: 'ss-status' });
  const grid = h('div', { class: 'ss-grid' });
  const scroller = h('div', { class: 'ss-scroll' }, grid);
  const hints = h('div', { class: 'ss-hints' });
  renderHints(hints, [
    ['confirm', 'Select'],
    ['x', 'Search'],
    ['y', 'Sort'],
    ['l1', 'Switch Tabs'],
    ['back', 'Close'],
  ]);
  const root = h(
    'div',
    { class: 'overlay sound-store' },
    h(
      'div',
      { class: 'ss-panel' },
      h('div', { class: 'ss-head' }, h('div', { class: 'ss-title', text: t('Sound Themes') }), h('div', { class: 'ss-tabs' }, ...tabs), status),
      scroller,
      h('div', { class: 'ss-foot' }, h('div', { class: 'ss-credit', text: t('Packs from deckthemes.com, made by the Steam Deck community.') }), hints)
    )
  );
  let nav = new FocusList([], { onChange: (el) => reveal(el) });
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 300) more();
  });

  const isInstalled = (id) => installed.some((p) => p.id === id);
  const inUse = (id) => state.settings.soundPack === id || state.settings.musicPack === id;

  function reveal(el) {
    if (!el) return;
    // Measured against the scroller itself (offsetTop would count the header too).
    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 28;
    const top = r.top - box.top + scroller.scrollTop;
    const bottom = top + r.height;
    // The first row always scrolls all the way up, so nothing is cut off above it.
    if (nav.index < COLS) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    else if (top < scroller.scrollTop + pad) scroller.scrollTo({ top: top - pad, behavior: 'smooth' });
    else if (bottom > scroller.scrollTop + scroller.clientHeight - pad) scroller.scrollTo({ top: bottom - scroller.clientHeight + pad, behavior: 'smooth' });
    if (nav.index >= items.length - COLS * 2) more();
  }

  function cardHtml(it) {
    const tag = busyId === it.id ? `<span class="ss-tag busy">${t('Downloading…')}</span>` : inUse(it.id) ? `<span class="ss-tag on">${icon('check')}${t('In Use')}</span>` : isInstalled(it.id) ? `<span class="ss-tag">${t('Installed')}</span>` : '';
    return `
      <div class="ss-img">${it.image ? `<img src="${escapeHtml(it.image)}" alt="" loading="lazy">` : icon('music')}</div>
      <div class="ss-name">${escapeHtml(it.name)}</div>
      <div class="ss-meta"><span>${escapeHtml(it.author)}</span><span>${icon('download')}${fmtCount(it.downloads)}</span></div>
      ${tag}`;
  }

  function render(keep = false) {
    const index = keep ? nav.index : 0;
    grid.innerHTML = '';
    const els = items.map((it, i) => {
      const el = h('button', { class: 'ss-card fx', html: cardHtml(it) });
      el.addEventListener('mouseenter', () => mouseActive() && nav.set(i));
      el.addEventListener('click', () => {
        nav.set(i);
        choose(i);
      });
      return el;
    });
    grid.append(...els);
    nav = new FocusList(els, { index: Math.max(0, Math.min(index, els.length - 1)), onChange: (el) => reveal(el) });
    tabs.forEach((b, i) => b.classList.toggle('active', (i === 0 ? 'Audio' : 'Music') === tab));
    status.textContent = loading && !items.length ? t('Loading…') : `${search ? `“${search}” · ` : ''}${t(order)}`;
    if (!loading && !items.length) grid.append(h('div', { class: 'ss-empty', text: t(search ? 'No packs match your search.' : "Couldn't reach deckthemes.com.") }));
  }

  async function load(reset) {
    if (loading) return;
    loading = true;
    if (reset) {
      page = 1;
      items = [];
      render();
    }
    try {
      installed = await api.soundPacks();
      const r = await api.browseSoundPacks({ page, search, order, kind: tab });
      total = r.total;
      items = reset ? r.items : items.concat(r.items);
    } catch (err) {
      if (reset) items = [];
    }
    loading = false;
    render(!reset);
  }

  function more() {
    if (loading || items.length >= total) return;
    page++;
    load(false);
  }

  function switchTab(k) {
    if (k === tab) return;
    tab = k;
    sfx.tab();
    load(true);
  }

  async function use(it) {
    await setSetting(tab === 'Music' ? 'musicPack' : 'soundPack', it.id);
    if (tab === 'Music' && !state.settings.ambient) await setSetting('ambient', true);
    pushNotification({ title: t('Sound theme changed'), body: it.name, icon: 'music', kind: 'system', silent: true });
    render(true);
    setTimeout(() => sfx.select(), 250);
  }

  async function choose(i) {
    const it = items[i];
    if (!it || busyId) return;
    sfx.select();
    const el = nav.current;
    const installedNow = isInstalled(it.id);
    const menu = [];
    if (!installedNow) {
      menu.push({
        label: 'Download and Use',
        icon: 'download',
        run: async () => {
          busyId = it.id;
          render(true);
          try {
            await api.downloadSoundPack({ id: it.id, downloadId: it.downloadId });
            installed = await api.soundPacks();
            emit('soundpacks-changed');
            busyId = null;
            await use(it);
          } catch (err) {
            busyId = null;
            render(true);
            sfx.error();
            pushNotification({ title: t("Couldn't download {name}", { name: it.name }), body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'info', kind: 'system' });
          }
        },
      });
    } else {
      if (!inUse(it.id)) menu.push({ label: 'Use This Theme', icon: 'check', run: () => use(it) });
      menu.push({
        label: 'Remove',
        icon: 'trash',
        danger: true,
        run: async () => {
          await api.removeSoundPack(it.id);
          installed = await api.soundPacks();
          emit('soundpacks-changed');
          render(true);
        },
      });
    }
    await optionsMenu({ title: it.name, anchor: el, items: menu });
  }

  async function askSearch() {
    const q = await textDialog({ title: 'Search Sound Themes', value: search, placeholder: 'PS5, Xbox, retro…' });
    if (q === null) return;
    search = q.trim();
    load(true);
  }

  async function askOrder() {
    const choice = await optionsMenu({ title: 'Sort By', items: ORDERS.map((o) => ({ label: o, value: o, checked: o === order })) });
    if (!choice || choice.value === order) return;
    order = choice.value;
    load(true);
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
    } else if (action === 'confirm') choose(nav.index);
    else if (action === 'x') askSearch();
    else if (action === 'y' || action === 'options') askOrder();
    else if (action === 'l1') switchTab('Audio');
    else if (action === 'r1') switchTab('Music');
    return true;
  }, { closeDelay: 320 });
  sfx.open();
  load(true);
  return ctl;
}
