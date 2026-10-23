// Uses the Sound Themes browser's panel, tabs, cards and focus navigation.
import { h, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { api, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { t } from '../i18n.js';
import { mountOverlay, FocusList } from './overlay.js';
import { optionsMenu, textDialog, screenshotViewer } from './dialogs.js';
import { renderHints } from './glyphs.js';

const COLS = 4;
const KINDS = [
  { value: 'grid', label: 'Tiles' },
  { value: 'capsule', label: 'Covers' },
  { value: 'hero', label: 'Backgrounds' },
  { value: 'logo', label: 'Logos' },
];

export async function steamGridDBPicker(game) {
  const initial = await chooseSteamGridDBGame(game.name);
  if (!initial) return;
  return new Promise(resolve => {
    let term = game.name, selected = initial, kind = 'grid';
    let page = 0, items = [], loading = false, exhausted = false, error = '';
    let generation = 0, busyId = null, editing = false;
    const applied = new Map();
    let nav = new FocusList([], { onChange: reveal });
    const tabs = KINDS.map(k => h('button', { class: 'ss-tab', text: t(k.label), onclick: () => switchTab(k.value) }));
    const status = h('div', { class: 'ss-status', role: 'status', 'aria-live': 'polite' });
    const grid = h('div', { class: 'ss-grid' });
    const scroller = h('div', { class: 'ss-scroll' }, grid);
    const hints = h('div', { class: 'ss-hints' });
    renderHints(hints, [['confirm', 'Select'], ['x', 'Search'], [['l1', 'r1'], 'Switch Tabs'], ['back', 'Close']]);
    const retry = h('button', { class: 'ss-tab', text: t('Retry'), onclick: () => load(!items.length) });
    const root = h('div', { class: 'overlay sound-store sgdb-store' },
      h('div', { class: 'ss-panel', role: 'dialog', 'aria-label': 'SteamGridDB' },
        h('div', { class: 'ss-head' }, h('div', { class: 'ss-title', text: 'SteamGridDB' }),
          h('div', { class: 'ss-tabs' }, ...tabs), status),
        scroller,
        h('div', { class: 'ss-foot' },
          h('div', { class: 'ss-credit', text: t('Artwork from the SteamGridDB community.') }),
          retry, hints)));
    const ctl = mountOverlay(root, action => {
      if (action === 'back') close();
      else if (busyId !== null || editing) return true;
      else if (action === 'left' || action === 'right') {
        nav.move(action === 'left' ? -1 : 1) ? sfx.move() : sfx.bump();
      } else if (action === 'up' || action === 'down') {
        const to = nav.index + (action === 'up' ? -COLS : COLS);
        if (to >= 0 && to < nav.els.length && nav.set(to)) sfx.move();
        else if (action === 'down' && nav.index < nav.els.length - 1 && nav.set(nav.els.length - 1)) sfx.move();
        else { if (action === 'down') more(); sfx.bump(); }
      } else if (action === 'confirm') {
        if (!items.length && error) load(true);
        else choose(nav.index);
      } else if (action === 'x') askSearch();
      else if (action === 'options' && error) load(!items.length);
      else if (action === 'l1' || action === 'r1') {
        const at = KINDS.findIndex(k => k.value === kind);
        switchTab(KINDS[(at + (action === 'l1' ? -1 : 1) + KINDS.length) % KINDS.length].value);
      }
      return true;
    }, { closeDelay: 320, onClose: () => { generation++; resolve(); } });
    scroller.addEventListener('scroll', () => {
      if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 300) more();
    });

    function close() { if (busyId === null && !editing) { sfx.back(); ctl.close(); } }
    function errorText(e) { return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    function reveal(el) {
      if (!el) return;
      const box = scroller.getBoundingClientRect(), r = el.getBoundingClientRect();
      const top = r.top - box.top + scroller.scrollTop, bottom = top + r.height, pad = 28;
      if (nav.index < COLS) scroller.scrollTo({ top: 0, behavior: 'smooth' });
      else if (top < scroller.scrollTop + pad) scroller.scrollTo({ top: top - pad, behavior: 'smooth' });
      else if (bottom > scroller.scrollTop + scroller.clientHeight - pad) scroller.scrollTo({ top: bottom - scroller.clientHeight + pad, behavior: 'smooth' });
      if (nav.index >= items.length - COLS * 2) more();
    }
    function updateStatus() {
      tabs.forEach((b, i) => {
        b.classList.toggle('active', KINDS[i].value === kind);
        b.setAttribute('aria-pressed', String(KINDS[i].value === kind));
      });
      status.textContent = error || (loading ? t('Loading…') : selected ? selected.name : `${t('Choose a game')} · ${term}`);
      retry.hidden = !error;
    }
    function card(it, i) {
      const image = h('div', { class: 'ss-img' });
      if (selected) {
        const img = h('img', { src: it.thumb, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => { img.hidden = true; image.append(h('span', { html: icon('image') })); });
        image.append(img);
      } else image.append(h('span', { html: icon('gamepad') }));
      const el = h('button', { class: 'ss-card fx' }, image,
        h('div', { class: 'ss-name', text: selected ? it.author : it.name }),
        h('div', { class: 'ss-meta' }, h('span', { text: selected ? `${it.width} × ${it.height}` : t('Browse artwork') })));
      if (busyId === it.id) el.append(h('span', { class: 'ss-tag busy', text: t('Downloading…') }));
      else if (selected && applied.get(kind) === it.id) el.append(h('span', { class: 'ss-tag on', text: t('In Use') }));
      el.addEventListener('mouseenter', () => { if (mouseActive() && busyId === null && !editing) nav.set(i); });
      el.addEventListener('click', () => { if (busyId === null && !editing) { nav.set(i); choose(i); } });
      return el;
    }
    function render(keep = false, appendFrom = 0) {
      const index = keep ? nav.index : 0;
      if (!appendFrom) grid.replaceChildren();
      grid.dataset.kind = selected ? kind : 'games';
      // Append new pages without restarting the existing cards' animations.
      const old = appendFrom ? nav.els : [];
      const added = items.slice(appendFrom).map((it, i) => card(it, appendFrom + i));
      grid.append(...added);
      nav.blur();
      nav = new FocusList([...old, ...added], { index: Math.max(0, index), onChange: reveal });
      if (!loading && !items.length) grid.append(h('div', { class: 'ss-empty', text: error || t(selected ? 'No artwork found.' : 'No games found. Try another name.') }));
      updateStatus();
    }
    async function load(reset) {
      if (ctl.closed || busyId !== null || (!reset && (loading || exhausted || !selected))) return;
      const token = reset ? ++generation : generation;
      const nextPage = reset ? 0 : page + 1;
      loading = true; error = '';
      if (reset) { items = []; exhausted = false; scroller.scrollTop = 0; render(); }
      else updateStatus();
      try {
        const result = selected ? await api.sgdbList(selected.id, kind, nextPage) : await api.sgdbSearch(term);
        if (ctl.closed || token !== generation) return;
        const oldLength = items.length;
        const ids = new Set(items.map(it => it.id));
        const fresh = result.filter(it => !ids.has(it.id));
        items = items.concat(fresh); page = nextPage;
        exhausted = !selected || !fresh.length;
        loading = false;
        render(!reset, reset ? 0 : oldLength);
      } catch (e) {
        if (ctl.closed || token !== generation) return;
        loading = false; error = errorText(e);
        if (!items.length) render(); else updateStatus();
      }
    }
    function more() { if (!error && !editing && busyId === null) load(false); }
    function switchTab(value) {
      if (value === kind || busyId !== null || editing || ctl.closed) return;
      kind = value; sfx.tab();
      if (selected) load(true); else updateStatus();
    }
    async function askSearch() {
      if (busyId !== null || editing || ctl.closed) return;
      editing = true;
      try {
        const choice = await chooseSteamGridDBGame(term);
        if (choice && !ctl.closed) { selected = choice; term = choice.name; load(true); }
      } finally { editing = false; }
    }
    async function choose(i) {
      const it = items[i];
      if (!it || busyId !== null || editing || ctl.closed) return;
      sfx.select();
      if (!selected) { selected = it; load(true); return; }
      editing = true;
      const chosenKind = kind;
      try {
        await optionsMenu({ title: it.author, anchor: nav.current, items: [
          { label: 'Preview', icon: 'image', run: () => screenshotViewer([{ full: it.url }]) },
          { label: 'Download and Use', icon: 'download', run: async () => {
            busyId = it.id; render(true);
            try {
              await api.sgdbApply(game.id, chosenKind, it.id);
              applied.set(chosenKind, it.id);
              pushNotification({ title: 'Artwork updated', body: game.name, icon: 'image', silent: false });
            } catch (e) {
              sfx.error();
              pushNotification({ title: "Couldn't download artwork", body: errorText(e), icon: 'info' });
            } finally { busyId = null; if (!ctl.closed) render(true); }
          } },
        ] });
      } finally { editing = false; }
    }
    sfx.open(); load(true);
  });
}

/** Use the same dialog and result rows as Find on Steam. */
function chooseSteamGridDBGame(name) {
  return new Promise(resolve => {
    let term = name, generation = 0, editing = false;
    let nav = new FocusList([]);
    const list = h('div', { class: 'match-list' });
    const termEl = h('div', { class: 'match-term' });
    const root = h('div', { class: 'overlay dialog-overlay' },
      h('div', { class: 'dialog match-dialog' },
        h('div', { class: 'dlg-title', text: t('Choose from SteamGridDB') }),
        h('div', { class: 'dlg-msg', text: t('Pick the game that matches this entry to browse its artwork.') }),
        termEl, list));
    const ctl = mountOverlay(root, action => {
      if (editing) return true;
      if (action === 'up' || action === 'down') {
        nav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
      } else if (action === 'confirm') pick(nav.index);
      else if (action === 'back') { sfx.back(); ctl.close(); }
      return true;
    }, { dimApp: true, onClose: () => { generation++; resolve(null); } });

    async function search() {
      const token = ++generation;
      termEl.innerHTML = `${icon('search')}<span>${escapeHtml(term)}</span>`;
      nav = new FocusList([]);
      list.innerHTML = '<div class="match-loading"><div class="spinner"></div></div>';
      let results = [], error = '';
      try { results = await api.sgdbSearch(term); }
      catch (e) { error = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      if (ctl.closed || token !== generation) return;
      const rows = [
        { kind: 'search', label: 'Search for a different name…', icon: 'search' },
        ...results.map(result => ({ ...result, kind: 'result' })),
        ...(error ? [{ kind: 'retry', label: 'Retry', icon: 'refresh' }] : []),
      ];
      const els = rows.map((row, i) => {
        const el = h('button', {
          class: `match-row fx fx-in ${row.kind}`,
          html: row.kind === 'result'
            ? `<span class="mr-ic">${icon('gamepad')}</span><span class="mr-name">${escapeHtml(row.name)}</span><span class="mr-id">${escapeHtml(String(row.id))}</span>`
            : `<span class="mr-ic">${icon(row.icon)}</span><span class="mr-name">${escapeHtml(t(row.label))}</span>`,
          onmouseenter: () => mouseActive() && !editing && nav.set(i),
          onclick: () => pick(i),
        });
        el._row = row;
        return el;
      });
      list.replaceChildren(...els);
      if (!results.length) list.append(h('div', { class: 'match-empty', text: error || t('No games found. Try another name.') }));
      nav = new FocusList(els, { index: results.length ? 1 : 0,
        onChange: el => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) });
      loadThumbnails(els.filter(el => el._row.kind === 'result'), token);

    }


    async function loadThumbnails(els, token) {
      const current = () => !ctl.closed && token === generation;
      const steamSearches = new Map();
      const normalize = value => String(value).normalize('NFKC').trim().toLowerCase();
      async function steamImage(row) {
        const key = normalize(row.name);
        if (!steamSearches.has(key)) {
          steamSearches.set(key, api.searchSteam(row.name).catch(() => []));
        }
        const matches = (await steamSearches.get(key)).filter(result => normalize(result.name) === key && result.image);
        // Avoid guessing between distinct Steam games with the same title.
        return matches.length === 1 ? matches[0].image : null;
      }
      async function show(el) {
        const row = el._row;
        async function gridImage() {
          try {
            const art = await api.sgdbList(row.id, 'hero', 0);
            return art[0]?.thumb || art[0]?.url;
          } catch { return null; }
        }
        let url = await steamImage(row);
        if (!current()) return;
        let usingGrid = !url;
        if (!url) url = await gridImage();
        if (!url || !current()) return;
        const placeholder = el.querySelector('.mr-ic');
        const img = h('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
        img.addEventListener('load', () => {
          if (current() && placeholder.parentNode === el) placeholder.replaceWith(img);
        });
        img.addEventListener('error', async () => {
          if (usingGrid || !current()) return;
          usingGrid = true;
          const fallback = await gridImage();
          if (fallback && current()) img.src = fallback;
        });
        img.src = url;
      }
      // Keep the chooser usable immediately and limit artwork requests.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, els.length) }, async () => {
        while (current() && next < els.length) await show(els[next++]);
      }));
    }

    async function pick(i) {
      const row = nav.els[i]?._row;
      if (!row || editing || ctl.closed) return;
      sfx.select();
      if (row.kind === 'retry') { search(); return; }
      if (row.kind === 'search') {
        editing = true;
        try {
          const value = await textDialog({ title: 'Search SteamGridDB', value: term });
          if (value?.trim() && !ctl.closed) { term = value.trim(); search(); }
        } finally { editing = false; }
        return;
      }
      resolve({ id: row.id, name: row.name });
      ctl.close();
    }
    sfx.open();
    search();
  });
}
