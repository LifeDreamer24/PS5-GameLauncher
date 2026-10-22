import { h } from '../util.js';
import { api, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { t } from '../i18n.js';
import { mountOverlay, FocusList } from './overlay.js';
import { optionsMenu, textDialog } from './dialogs.js';
import { renderHints } from './glyphs.js';

const KINDS = [
  { value: 'grid', label: 'Tile Image' },
  { value: 'capsule', label: 'Portrait Cover' },
  { value: 'hero', label: 'Background' },
  { value: 'logo', label: 'Logo' },
];

export function steamGridDBPicker(game) {
  return new Promise(resolve => {
    let term = game.name, selected = null, kind = 'grid', page = 0;
    let busy = false, saving = false, editing = false, requestId = 0, items = [], controls = [];
    const nav = new FocusList();
    const toolbar = h('div', { class: 'sgdb-toolbar' });
    const status = h('div', { class: 'sgdb-status', role: 'status', 'aria-live': 'polite' });
    const list = h('div', { class: 'sgdb-results' });
    const hints = h('div', { class: 'dlg-hints' });
    renderHints(hints, [['confirm', 'Select'], ['back', 'Back']]);
    const root = h('div', { class: 'overlay dialog-overlay' },
      h('div', { class: 'dialog sgdb-dialog', role: 'dialog', 'aria-label': 'SteamGridDB' },
        h('div', { class: 'dlg-title', text: 'SteamGridDB' }),
        h('div', { class: 'dlg-msg', text: game.name }), toolbar, status, list, hints));
    const ctl = mountOverlay(root, action => {
      if (action === 'back') {
        if (saving || editing) return true;
        if (!busy && selected) { selected = null; load(); }
        else close();
      } else if (!busy && !editing) {
        if (action === 'confirm') nav.current?.click();
        else if (['left', 'right', 'up', 'down'].includes(action)) move(action);
      }
      return true;
    }, { dimApp: true, onClose: () => { requestId++; resolve(); } });

    function close() { sfx.back(); ctl.close(); }
    function errorText(error) {
      return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
    function focus(i) {
      if (nav.set(i)) {
        nav.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        sfx.move();
      }
    }
    function move(action) {
      const n = controls.length, i = nav.index, cols = selected ? 4 : 1;
      let next = i;
      if (i < n) {
        if (action === 'left') next = Math.max(0, i - 1);
        if (action === 'right') next = Math.min(n - 1, i + 1);
        if (action === 'down' && items.length) next = n;
      } else {
        const at = i - n;
        if (action === 'up') next = at < cols ? 0 : i - cols;
        if (action === 'down' && at + cols < items.length) next = i + cols;
        if (action === 'left' && at % cols > 0) next = i - 1;
        if (action === 'right' && at % cols < cols - 1 && at + 1 < items.length) next = i + 1;
      }
      next === i ? sfx.bump() : focus(next);
    }
    function bind(el, i, run) {
      el.addEventListener('mouseenter', () => { if (mouseActive() && !busy && !editing) nav.set(i); });
      el.addEventListener('click', async () => {
        if (busy || editing || ctl.closed) return;
        nav.set(i);
        sfx.select();
        await run();
      });
      return el;
    }
    async function changeSearch() {
      editing = true;
      try {
        const value = await textDialog({ title: 'Search SteamGridDB', value: term });
        if (value?.trim() && !ctl.closed) { term = value.trim(); selected = null; await load(); }
      } finally { editing = false; }
    }
    async function changeKind() {
      editing = true;
      try {
        const choice = await optionsMenu({ title: 'Artwork Type', items: KINDS.map(k => ({ ...k, checked: kind === k.value })) });
        if (choice && !ctl.closed) { kind = choice.value; page = 0; await load(); }
      } finally { editing = false; }
    }
    function render() {
      toolbar.replaceChildren(); list.replaceChildren();
      const defs = [{ label: 'Search…', run: changeSearch }];
      if (selected) {
        defs.push({ label: KINDS.find(k => k.value === kind).label, run: changeKind });
        defs.push({ label: 'Change Game', run: () => { selected = null; return load(); } });
        if (page > 0) defs.push({ label: 'Previous Page', run: () => { page--; return load(); } });
        // An empty next page remains navigable via Previous Page.
        if (items.length) defs.push({ label: 'Next Page', run: () => { page++; return load(); } });
      }
      defs.push({ label: 'Retry', run: load }, { label: 'Close', run: close });
      controls = defs.map((d, i) => bind(h('button', { class: 'sgdb-control fx', text: t(d.label) }), i, d.run));
      toolbar.append(...controls);
      list.classList.toggle('artwork', !!selected);
      list.dataset.kind = kind;
      const cards = items.map((item, i) => {
        const el = h('button', { class: 'sgdb-card fx', 'aria-label': selected ? `${item.author}, ${item.width} × ${item.height}` : item.name });
        if (selected) {
          const img = h('img', { src: item.thumb, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
          img.addEventListener('error', () => { img.hidden = true; });
          el.append(h('div', { class: 'sgdb-thumb' }, img), h('span', { text: `${item.width} × ${item.height} · ${item.author}` }));
        } else el.append(h('span', { text: item.name }));
        return bind(el, controls.length + i, async () => {
          if (!selected) { selected = item; page = 0; await load(); return; }
          busy = true; saving = true; status.textContent = t('Saving artwork…');
          try {
            await api.sgdbApply(game.id, kind, item.id);
            pushNotification({ title: 'Artwork updated', body: game.name, icon: 'image', silent: false });
            ctl.close();
          } catch (error) { if (!ctl.closed) status.textContent = errorText(error); }
          finally { busy = false; saving = false; }
        });
      });
      list.append(...cards);
      nav.setItems([...controls, ...cards], cards.length ? controls.length : 0);
    }
    async function load() {
      const token = ++requestId;
      busy = true; items = []; nav.setItems([]); list.replaceChildren(); toolbar.replaceChildren();
      status.textContent = t('Loading…');
      // Close stays available while remote requests are pending.
      toolbar.append(h('button', { class: 'sgdb-control fx', text: t('Close'), onclick: close }));
      try {
        const result = selected ? await api.sgdbList(selected.id, kind, page) : await api.sgdbSearch(term);
        if (ctl.closed || token !== requestId) return;
        items = result;
        status.textContent = selected
          ? `${selected.name} · ${t(KINDS.find(k => k.value === kind).label)} · ${page + 1}${items.length ? '' : ' · ' + t('No artwork found.')}`
          : `${term}${items.length ? '' : ' · ' + t('No games found. Try another name.')}`;
      } catch (error) {
        if (ctl.closed || token !== requestId) return;
        status.textContent = errorText(error);
      } finally {
        if (!ctl.closed && token === requestId) { busy = false; render(); }
      }
    }
    sfx.open();
    load();
  });
}
