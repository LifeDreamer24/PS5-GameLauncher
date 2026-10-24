// The launcher's own file browser, instead of Windows' file dialogs and
// Explorer (which open on top of the launcher): pick a file or a folder, or
// look at where something is, all with the controller.
//
//   Places on the left (This PC, the user's folders, every drive), the folder's
//   contents on the right, the path above. Square goes up a level, Options has
//   Go to a Path…, New Folder, Sort and the way out to File Explorer.

import { h, escapeHtml, fmtDate } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { mountOverlay, FocusList } from './overlay.js';
import { renderHints } from './glyphs.js';
import { optionsMenu, textDialog } from './dialogs.js';
import { toast } from './toast.js';
import { fmtSize } from '../views/storage.js';
import { t } from '../i18n.js';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const VIDEO = /\.(mp4|mkv|webm|avi|mov|wmv)$/i;
const AUDIO = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i;
const ROM = /\.(nsp|xci|nro|nca|iso|cso|chd|rvz|wbfs|cia|3ds|nds|gba|gbc|gb|sfc|smc|nes|n64|z64|bin|cue)$/i;
// Their own icon (what Explorer shows), fetched for the rows on screen.
const OWN_ICON = /\.(exe|lnk|url|ico)$/i;
const ROWS_ABOVE = 3;

const join = (dir, name) => (/[\\/]$/.test(dir) ? dir + name : `${dir}\\${name}`);
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function remember(key, dir) {
  if (!key) return;
  try {
    localStorage.setItem(`fb:${key}`, dir || '');
  } catch {}
}
function remembered(key) {
  if (!key) return null;
  try {
    return localStorage.getItem(`fb:${key}`) || null;
  } catch {
    return null;
  }
}

function fileIcon(name) {
  if (IMAGE.test(name)) return icon('image');
  if (VIDEO.test(name)) return icon('camera');
  if (AUDIO.test(name)) return icon('music');
  if (ROM.test(name)) return icon('gamepad');
  return icon('file');
}

/**
 * Open the file browser.
 * @param {object} o
 * @param {string} o.title
 * @param {'file'|'folder'|'view'} [o.mode]  pick a file, pick a folder, or just look
 * @param {string[]} [o.exts]   file mode: the extensions that can be picked
 * @param {boolean} [o.multi]   file mode: several files (Cross marks them)
 * @param {string} [o.start]    folder to open (else the last one used for `key`, else This PC)
 * @param {string} [o.select]   file to point at in the start folder
 * @param {string} [o.key]      remembers the last folder for this kind of pick
 * @returns {Promise<string|string[]|null>} the pick (null when cancelled; view mode: null)
 */
export function browseFiles({ title, mode = 'file', exts = null, multi = false, start = null, select = null, key = null } = {}) {
  return new Promise((resolve) => {
    let dir = null; // null = This PC
    let entries = [];
    let placesList = [];
    let sort = 'name';
    let zone = 'list';
    let done = false;
    let loading = 0;
    const marked = new Set();

    const titleEl = h('div', { class: 'fb-title', text: t(title || (mode === 'folder' ? 'Choose a Folder' : mode === 'view' ? 'File Location' : 'Choose a File')) });
    const crumbs = h('div', { class: 'fb-crumbs' });
    const placesEl = h('div', { class: 'fb-places' });
    const list = h('div', { class: 'fb-list' });
    const listWrap = h('div', { class: 'fb-list-wrap' }, list);
    const empty = h('div', { class: 'fb-empty' });
    const filter = h('div', { class: 'fb-filter' });
    const btnDefs = [];
    if (mode === 'folder') btnDefs.push({ id: 'pick', label: 'Select This Folder', primary: true, disabled: () => !dir });
    if (mode === 'file' && multi) btnDefs.push({ id: 'pick', label: () => (marked.size ? t('Add {n} Selected', { n: marked.size }) : t('Add Selected')), primary: true, disabled: () => !marked.size });
    btnDefs.push({ id: 'cancel', label: mode === 'view' ? 'Close' : 'Cancel' });
    const btns = btnDefs.map((b, i) => {
      const el = h('button', { class: `fb-btn fx${b.primary ? ' primary' : ''}` });
      el.addEventListener('mouseenter', () => mouseActive() && !el.classList.contains('disabled') && focusZone('buttons', i));
      el.addEventListener('click', () => {
        focusZone('buttons', i);
        press(b);
      });
      return el;
    });
    const hints = h('div', { class: 'fb-hints' });
    const foot = h('div', { class: 'fb-foot' }, h('div', { class: 'fb-btns' }, ...btns), hints);
    const root = h('div', { class: 'overlay fb-overlay' }, titleEl, crumbs, placesEl, listWrap, empty, filter, foot);

    let rowEls = [];
    let placeEls = [];
    const listNav = new FocusList([], { onChange: () => scroll() });
    const placeNav = new FocusList([], { onChange: (el) => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) });
    const btnNav = new FocusList(btns);

    if (mode === 'file' && exts && exts.length) filter.textContent = t('Shows: {types}', { types: exts.map((e) => `.${e}`).join('  ') });

    /* ---- Loading ------------------------------------------------- */

    async function loadPlaces() {
      try {
        placesList = await api.fsPlaces();
      } catch {
        placesList = [];
      }
      const all = [{ path: null, label: 'This PC', icon: 'system', kind: 'pc' }, ...placesList];
      placeEls = all.map((p, i) => {
        const el = h('button', {
          class: 'fb-place fx fx-in',
          html: `<span class="fb-place-icon">${icon(p.icon)}</span><span class="fb-place-label">${escapeHtml(t(p.label))}</span>`,
        });
        el._place = p;
        el.addEventListener('mouseenter', () => mouseActive() && focusZone('places', i));
        el.addEventListener('click', () => {
          focusZone('places', i);
          openPlace(p);
        });
        return el;
      });
      placesEl.replaceChildren(h('div', { class: 'fb-places-head', text: t('Places') }), ...placeEls);
      placeNav.setItems(placeEls, 0);
      markPlace();
      applyZone();
    }

    /** Open a folder (null: This PC). focusName: the entry to point at. */
    async function open(next, focusName = null) {
      const token = ++loading;
      if (next == null) {
        dir = null;
        entries = placesList.map((p) => ({ name: p.label, dir: true, place: p }));
        render(focusName);
        return true;
      }
      let res;
      try {
        res = await api.fsList(next, { exts: mode === 'file' ? exts : null, files: mode !== 'folder' });
      } catch (err) {
        if (token !== loading) return false;
        sfx.error();
        toast({ title: t('Can’t open {name}', { name: baseName(next) }), body: t(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), icon: 'info' });
        return false;
      }
      if (token !== loading || done) return false;
      dir = res.dir;
      entries = res.entries;
      if (res.truncated) toast({ title: t('Only the first {n} items are shown', { n: res.entries.length }), icon: 'info' });
      render(focusName);
      return true;
    }

    function sorted(list) {
      if (sort === 'name' || dir == null) return list;
      const by = sort === 'date' ? (a, b) => (b.mtime || 0) - (a.mtime || 0) : (a, b) => (b.size || 0) - (a.size || 0);
      return [...list].sort((a, b) => (a.dir === b.dir ? by(a, b) : a.dir ? -1 : 1));
    }

    function render(focusName) {
      const shown = sorted(entries);
      rowEls = shown.map((e, i) => {
        const full = e.place ? e.place.path : join(dir, e.name);
        let iconHtml;
        if (e.place) iconHtml = icon(e.place.icon);
        else if (e.dir) iconHtml = icon('folder');
        else iconHtml = fileIcon(e.name);
        let meta = '';
        if (e.place && e.place.kind === 'drive' && e.place.total) meta = t('{free} free of {total}', { free: fmtSize(e.place.free), total: fmtSize(e.place.total) });
        else if (!e.place) meta = [e.dir ? '' : e.size != null ? fmtSize(e.size) : '', e.mtime ? fmtDate(e.mtime) : ''].filter(Boolean).join('   ');
        const el = h('button', {
          class: `fb-row fx fx-in${e.dir ? ' is-dir' : ''}`,
          html: `<span class="fb-check">${icon('check')}</span><span class="fb-icon">${iconHtml}</span><span class="fb-name">${escapeHtml(t(e.name))}</span><span class="fb-meta">${escapeHtml(meta)}</span>${
            e.dir ? `<span class="fb-chev">${icon('chevronRight')}</span>` : ''
          }`,
        });
        el._entry = e;
        el._path = full;
        el.addEventListener('mouseenter', () => mouseActive() && focusZone('list', i));
        el.addEventListener('click', () => {
          focusZone('list', i);
          activate();
        });
        return el;
      });
      list.replaceChildren(...rowEls);
      let idx = focusName ? shown.findIndex((e) => e.name.toLowerCase() === String(focusName).toLowerCase()) : 0;
      if (idx < 0) idx = 0;
      listNav.setItems(rowEls, idx);
      empty.textContent = dir == null ? '' : mode === 'file' && exts ? t('No folders or matching files here.') : t('This folder is empty.');
      empty.style.display = rowEls.length ? 'none' : '';
      if (!rowEls.length && zone === 'list') zone = 'places';
      renderCrumbs();
      markPlace();
      paint();
      scroll(true);
      loadIcons();
    }

    function renderCrumbs() {
      const parts = [{ label: t('This PC'), path: null }];
      if (dir) {
        const segs = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
        let acc = '';
        segs.forEach((s, i) => {
          acc = i === 0 ? `${s}\\` : join(acc, s);
          parts.push({ label: i === 0 ? s : s, path: acc });
        });
      }
      crumbs.replaceChildren(
        ...parts.flatMap((p, i) => {
          const el = h('button', { class: `fb-crumb${i === parts.length - 1 ? ' last' : ''}`, text: p.label });
          el.addEventListener('click', () => {
            sfx.select();
            open(p.path);
          });
          return i ? [h('span', { class: 'fb-crumb-sep', html: icon('chevronRight') }), el] : [el];
        })
      );
    }

    /** The place the current folder is in, lit in the left column. */
    function markPlace() {
      let best = -1;
      let bestLen = -1;
      placeEls.forEach((el, i) => {
        const p = el._place.path;
        const hit = p == null ? dir == null : dir && (dir.toLowerCase() === p.toLowerCase() || dir.toLowerCase().startsWith(p.toLowerCase().replace(/[\\/]+$/, '') + '\\'));
        const len = p == null ? 0 : p.length;
        if (hit && len > bestLen) {
          best = i;
          bestLen = len;
        }
      });
      placeEls.forEach((el, i) => el.classList.toggle('active', i === best));
    }

    // The programs' own icons, for the rows on screen.
    let iconTimer = null;
    function loadIcons() {
      clearTimeout(iconTimer);
      iconTimer = setTimeout(() => {
        const from = Math.max(0, listNav.index - 6);
        for (const el of rowEls.slice(from, from + 24)) {
          const e = el._entry;
          if (e.dir || e.place || el._iconAsked || !OWN_ICON.test(e.name)) continue;
          el._iconAsked = true;
          api
            .fsIcon(el._path)
            .then((url) => {
              if (url && !done) el.querySelector('.fb-icon').innerHTML = `<img src="${url}" alt="">`;
            })
            .catch(() => {});
        }
      }, 60);
    }

    /* ---- Focus ---------------------------------------------------- */

    function paint() {
      rowEls.forEach((el) => el.classList.toggle('on', marked.has(el._path)));
      root.classList.toggle('multi', mode === 'file' && multi);
      btns.forEach((el, i) => {
        const b = btnDefs[i];
        el.textContent = typeof b.label === 'function' ? b.label() : t(b.label);
        el.classList.toggle('disabled', !!(b.disabled && b.disabled()));
      });
      updateHints();
      applyZone();
    }

    function updateHints() {
      const cur = listNav.current && listNav.current._entry;
      const list = [];
      if (zone === 'list' && cur) {
        if (cur.dir) list.push(['confirm', 'Open']);
        else if (mode === 'file') list.push(['confirm', multi ? (marked.has(listNav.current._path) ? 'Unselect' : 'Select') : 'Select']);
        else if (mode === 'view') list.push(['confirm', 'Select']);
      } else if (zone !== 'list') list.push(['confirm', 'Select']);
      if (dir) list.push(['x', 'Up One Level']);
      if (mode === 'folder' && dir) list.push(['y', 'Select This Folder']);
      if (mode === 'file' && multi && marked.size) list.push(['y', 'Add Selected']);
      list.push(['options', 'Options']);
      list.push(['back', mode === 'view' ? 'Close' : 'Cancel']);
      renderHints(hints, list);
    }

    function applyZone() {
      listNav.blur();
      placeNav.blur();
      btnNav.blur();
      if (zone === 'list') listNav.refocus();
      else if (zone === 'places') placeNav.refocus();
      else btnNav.refocus();
      root.dataset.zone = zone;
    }

    function focusZone(z, i) {
      zone = z;
      if (z === 'list') listNav.set(i, { silent: true });
      else if (z === 'places') placeNav.set(i, { silent: true });
      else btnNav.set(i, { silent: true });
      updateHints();
      applyZone();
    }

    function scroll(instant = false) {
      const el = rowEls[listNav.index];
      if (!el) {
        list.style.transform = '';
        return;
      }
      const rowH = el.offsetHeight || 1;
      const visible = Math.floor(listWrap.clientHeight / rowH);
      const max = Math.max(0, rowEls.length - visible + 1);
      const top = Math.min(max, Math.max(0, listNav.index - ROWS_ABOVE));
      list.style.transition = instant ? 'none' : '';
      list.style.transform = `translateY(${-top * rowH}px)`;
      listWrap.classList.toggle('fade-top', top > 0);
      if (instant) {
        void list.offsetWidth;
        list.style.transition = '';
      }
      updateHints();
      loadIcons();
    }

    /* ---- Actions -------------------------------------------------- */

    function finish(value) {
      if (done) return;
      if (dir && mode !== 'view') remember(key, dir);
      ctl.close(value);
    }

    function openPlace(p) {
      sfx.select();
      open(p.path).then((ok) => {
        if (ok && rowEls.length) {
          zone = 'list';
          applyZone();
          updateHints();
        }
      });
    }

    async function up() {
      if (!dir) return sfx.bump();
      sfx.back();
      const parent = dir.replace(/[\\/]+$/, '').split(/[\\/]/).length > 1 ? dir.replace(/[\\/][^\\/]+[\\/]*$/, '') : null;
      const from = baseName(dir);
      // A drive's root goes up to This PC.
      const target = parent && parent.length >= 2 ? (/^[a-z]:$/i.test(parent) ? `${parent}\\` : parent) : null;
      await open(target, target == null ? placesList.find((p) => p.path && p.path.toLowerCase() === dir.toLowerCase())?.label : from);
    }

    async function activate() {
      const el = listNav.current;
      if (!el) return sfx.bump();
      const e = el._entry;
      if (e.dir) {
        sfx.select();
        await open(el._path);
        return;
      }
      if (mode === 'file') {
        if (multi) {
          if (marked.has(el._path)) marked.delete(el._path);
          else marked.add(el._path);
          sfx.toggle(marked.has(el._path));
          paint();
          return;
        }
        sfx.select();
        finish(el._path);
        return;
      }
      if (mode === 'view') return fileMenu(el);
      sfx.bump();
    }

    async function fileMenu(el) {
      sfx.select();
      await optionsMenu({
        title: el._entry.name,
        anchor: el,
        side: 'below-right',
        items: [
          { label: 'Open', icon: 'play', run: () => api.fsOpen(el._path) },
          { label: 'Show in File Explorer', icon: 'external', run: () => api.fsShowInExplorer(el._path) },
        ],
      });
    }

    function press(b) {
      if (b.disabled && b.disabled()) return sfx.bump();
      if (b.id === 'cancel') {
        sfx.back();
        finish(null);
      } else if (b.id === 'pick') {
        sfx.select();
        finish(mode === 'folder' ? dir : [...marked]);
      }
    }

    async function options() {
      sfx.select();
      const cur = zone === 'list' && listNav.current && !listNav.current._entry.place ? listNav.current._path : null;
      const SORTS = [
        { value: 'name', label: 'Name' },
        { value: 'date', label: 'Date Modified' },
        { value: 'size', label: 'Size' },
      ];
      await optionsMenu({
        title: t('Options'),
        anchor: hints,
        side: 'above',
        items: [
          {
            label: 'Go to a Path…',
            icon: 'edit',
            run: async () => {
              const p = await textDialog({ title: 'Go to a Path', value: dir || '', placeholder: 'C:\\Games' });
              if (!p || !p.trim()) return;
              const target = p.trim().replace(/^"|"$/g, '');
              const kind = await api.fsKind(target).catch(() => null);
              if (kind === 'dir') open(target);
              else if (kind === 'file') open(target.replace(/[\\/][^\\/]+$/, '') || target, baseName(target));
              else {
                sfx.error();
                toast({ title: t('Can’t open {name}', { name: target }), body: t('This folder isn’t there any more.'), icon: 'info' });
              }
            },
          },
          mode === 'folder' && dir
            ? {
                label: 'New Folder…',
                icon: 'folderPlus',
                run: async () => {
                  const name = await textDialog({ title: 'New Folder', value: '' });
                  if (!name || !name.trim()) return;
                  try {
                    const made = await api.fsMkdir(dir, name.trim());
                    await open(dir, baseName(made));
                  } catch (err) {
                    sfx.error();
                    toast({ title: t('Couldn’t make the folder'), body: t(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), icon: 'info' });
                  }
                },
              }
            : null,
          dir
            ? {
                label: 'Sort by',
                icon: 'sort',
                hint: SORTS.find((s) => s.value === sort).label,
                submenu: true,
                run: async () => {
                  const c = await optionsMenu({ title: 'Sort by', anchor: hints, side: 'above', items: SORTS.map((s) => ({ ...s, checked: s.value === sort })) });
                  if (c && c.value !== sort) {
                    sort = c.value;
                    render(listNav.current && listNav.current._entry.name);
                  }
                },
              }
            : null,
          cur || dir ? { label: 'Show in File Explorer', icon: 'external', run: () => api.fsShowInExplorer(cur || dir) } : null,
        ].filter(Boolean),
      });
    }

    /* ---- Input ---------------------------------------------------- */

    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'back') {
          sfx.back();
          finish(null);
          return true;
        }
        if (action === 'options') {
          options();
          return true;
        }
        if (action === 'x') {
          up();
          return true;
        }
        if (action === 'y') {
          const pick = btnDefs.find((b) => b.id === 'pick');
          if (pick) press(pick);
          else sfx.bump();
          return true;
        }
        if (zone === 'list') {
          if (action === 'up') listNav.move(-1) ? sfx.move() : sfx.bump();
          else if (action === 'down') {
            if (listNav.move(1)) sfx.move();
            else {
              zone = 'buttons';
              sfx.move();
              updateHints();
              applyZone();
            }
          } else if (action === 'l1' || action === 'r1') {
            const i = Math.max(0, Math.min(rowEls.length - 1, listNav.index + (action === 'l1' ? -8 : 8)));
            if (i !== listNav.index) {
              listNav.set(i);
              sfx.move();
            } else sfx.bump();
          } else if (action === 'left') {
            // Onto the place the folder is in.
            const here = placeEls.findIndex((el) => el.classList.contains('active'));
            if (here >= 0) placeNav.set(here, { silent: true });
            zone = 'places';
            sfx.move();
            updateHints();
            applyZone();
          } else if (action === 'confirm' || action === 'right') {
            if (action === 'right' && !(listNav.current && listNav.current._entry.dir)) sfx.bump();
            else activate();
          } else sfx.bump();
        } else if (zone === 'places') {
          if (action === 'up' || action === 'down') placeNav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
          else if (action === 'right') {
            if (rowEls.length) {
              zone = 'list';
              sfx.move();
              updateHints();
              applyZone();
            } else sfx.bump();
          } else if (action === 'confirm') openPlace(placeNav.current._place);
          else sfx.bump();
        } else if (zone === 'buttons') {
          if (action === 'left' || action === 'right') {
            let i = btnNav.index;
            do i += action === 'left' ? -1 : 1;
            while (btns[i] && btns[i].classList.contains('disabled'));
            if (btns[i]) {
              btnNav.set(i);
              sfx.move();
            } else sfx.bump();
          } else if (action === 'up') {
            zone = rowEls.length ? 'list' : 'places';
            sfx.move();
            updateHints();
            applyZone();
          } else if (action === 'confirm') press(btnDefs[btnNav.index]);
          else sfx.bump();
        }
        return true;
      },
      {
        closeDelay: 260,
        onClose: (value) => {
          // Also clean up when navigation closes the overlay directly.
          done = true;
          clearTimeout(iconTimer);
          document.body.classList.remove('fb-open');
          resolve(value ?? null);
        },
      }
    );

    listWrap.addEventListener('wheel', (e) => {
      if (!rowEls.length) return;
      const i = Math.max(0, Math.min(rowEls.length - 1, listNav.index + (e.deltaY > 0 ? 3 : -3)));
      focusZone('list', i);
      scroll();
    });

    document.body.classList.add('fb-open');
    sfx.open();
    paint();
    (async () => {
      await loadPlaces();
      const first = start || remembered(key);
      const kind = first ? await api.fsKind(first).catch(() => null) : null;
      if (kind !== 'dir' || !(await open(first, select))) await open(null);
    })();
  });
}

/* ------------------------------------------------------------------ */
/* What the launcher picks with it                                      */
/* ------------------------------------------------------------------ */

const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

export function pickImage(title, key = 'image') {
  return browseFiles({ title, mode: 'file', exts: IMAGES, key });
}

/** Library › Add Folder: a folder with game shortcuts. */
export async function addGameFolder() {
  const dir = await browseFiles({ title: 'Choose a Folder With Games', mode: 'folder', key: 'games' });
  return dir ? api.addFolder(dir) : null;
}

/** Library › Add Games from Files: shortcuts and programs. */
export async function addGameFiles() {
  const list = await browseFiles({ title: 'Add Games', mode: 'file', multi: true, exts: ['exe', 'lnk', 'url', 'bat', 'cmd'], key: 'games' });
  return list && list.length ? api.addFiles(list) : 0;
}

/** A game's Open File Location: its folder, with its file picked out. */
export async function showGameLocation(game) {
  const at = await api.gameLocation(game.id).catch(() => null);
  if (!at) {
    sfx.error();
    toast({ title: game.name, body: t('Its files couldn’t be found.'), icon: 'info' });
    return;
  }
  await browseFiles({ title: game.name, mode: 'view', start: at.dir, select: at.file });
}

/** A folder to look at (captures, the launcher's data), optionally with one file picked out. */
export function showFolder(title, dir, file = null) {
  return browseFiles({ title, mode: 'view', start: dir, select: file });
}
