// Steam updates in the interface: wording, progress, the tile progress bar and
// starting an update (the data comes from main/steamdownloads.js).

import { h, fmtBytes, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { api, state, findGame, downloadFor, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { mountOverlay, FocusList } from './overlay.js';
import { renderHints } from './glyphs.js';
import { tileArt } from './tiles.js';
import { t } from '../i18n.js';

export const ACTIVE = new Set(['starting', 'queued', 'downloading', 'installing', 'paused']);

/** Steam is working on it right now: the bar gets the PS5's moving glow. */
export const pulsing = (d) => !!d && (d.status === 'downloading' || d.status === 'installing');

/** "10 min left", "1 h 5 min left". */
export function fmtLeft(sec) {
  if (!(sec > 0)) return '';
  const m = Math.ceil(sec / 60);
  if (m < 2) return t('Less than a minute left');
  if (m < 60) return t('{m} min left', { m });
  return t('{h} h {m} min left', { h: Math.floor(m / 60), m: m % 60 });
}

/** Download speed arrives in bytes/s; display decimal megabits/s. */
export function fmtSpeed(bytesPerSecond) {
  if (!(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return '';
  const megabits = (bytesPerSecond * 8) / 1_000_000;
  return `${megabits.toFixed(megabits < 1 ? 2 : 1)} Mb/s`;
}

/** What is happening, in a few words. */
export function statusText(d) {
  if (!d) return '';
  switch (d.status) {
    case 'downloading':
      return d.phase === 'preparing' ? t('Preparing…') : t('Downloading update');
    case 'installing':
      return d.phase === 'checking' ? t('Checking game files…') : d.phase === 'verifying' ? t('Verifying…') : t('Installing…');
    case 'queued':
      return t('Queued');
    case 'starting':
      if (d.restartingSteam) return t('Restarting Steam…');
      if (d.waitingSteam) return t('Starting Steam…');
      return d.phase === 'confirm' ? t('Confirm the install in Steam') : t('Starting…');
    case 'paused':
      return d.steamRunning ? t('Paused') : t('Waiting for Steam');
    case 'error':
      return d.error ? t(d.error) : t("Couldn't update");
    default:
      return d.scheduled ? t('Update available · Steam updates it {when}', { when: when(d.scheduled) }) : t('Update available');
  }
}

function when(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return t('at {time}', { time });
  return t('on {date}', { date: d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) });
}

/** 0…1 for the progress bar (installing: what has been written so far). */
export function progressOf(d) {
  if (!d) return 0;
  if (d.status === 'installing' && d.phase !== 'checking' && d.stageTotal > 0) return Math.min(1, d.staged / d.stageTotal);
  return d.total > 0 ? Math.min(1, d.done / d.total) : 0;
}

/** "8.0 GB/23.3 GB (10 min left)" for the Downloads screen. */
export function sizeLine(d) {
  if (!d || !d.total) return '';
  const left = d.status === 'downloading' ? fmtLeft(d.eta) : '';
  return `${fmtBytes(d.done)}/${fmtBytes(d.total)}${left ? ` (${left})` : ''}`;
}

/** Ask Steam to update the game now. */
export async function startUpdate(game) {
  if (!game) return;
  sfx.select();
  try {
    await api.downloadsUpdate(game.id);
    pushNotification({ title: 'Update requested', body: game.name, icon: 'download', kind: 'downloads', silent: true });
  } catch (err) {
    sfx.error();
    pushNotification({ title: t("Couldn't update {name}", { name: game.name }), body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'info', kind: 'downloads' });
  }
}

/** Download a game the account owns: Steam asks where to install it, then it downloads like an update. */
export async function startInstall(game) {
  if (!game) return;
  sfx.select();
  let info = null;
  try {
    info = await api.downloadsInstallInfo(game.id);
  } catch {}
  // No library to choose from (Steam not found…): Steam's own install dialog.
  const library = info && info.libraries.length ? await installDialog(game, info) : undefined;
  if (library === null) return; // cancelled
  try {
    await api.downloadsInstall(game.id, library);
    if (!library) pushNotification({ title: 'Confirm the install in Steam', body: game.name, icon: 'download', kind: 'downloads', silent: true });
  } catch (err) {
    sfx.error();
    pushNotification({ title: t("Couldn't download {name}", { name: game.name }), body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'info', kind: 'downloads' });
  }
}

/**
 * The launcher's own "where to install" step (instead of Steam's dialog):
 * the game's sizes and each Steam library drive with its free space.
 * Resolves with the chosen library folder, or null when cancelled.
 */
function installDialog(game, info) {
  return new Promise((resolve) => {
    const need = info.size || info.download || 0;
    const fits = (l) => !need || !l.free || l.free > need * 1.05;
    // Pre-selected: the drive with the most room that fits.
    const sorted = info.libraries.slice().sort((a, b) => b.free - a.free);
    let chosen = (sorted.find(fits) || sorted[0]).path;
    const blocked = info.gameRunning;
    const libEls = info.libraries.map((l) => {
      const ok = fits(l);
      const el = h('button', {
        class: `id-lib fx${ok ? '' : ' disabled'}`,
        html: `<span class="id-radio"><i></i></span>
          <span class="id-drive">${icon('storage')}</span>
          <span class="id-text"><b>${escapeHtml(l.drive)}</b><em>${escapeHtml(l.path)}</em></span>
          <span class="id-free">${escapeHtml(ok ? t('{size} free', { size: fmtBytes(l.free) }) : t('Not enough space'))}</span>
          ${l.total ? `<span class="id-bar"><i style="width:${Math.min(100, Math.round(((l.total - l.free) / l.total) * 100))}%"></i></span>` : ''}`,
      });
      el._lib = l;
      return el;
    });
    const go = h('button', { class: `dlg-btn fx${blocked ? ' disabled' : ''}`, text: t('Download') });
    const cancel = h('button', { class: 'dlg-btn fx', text: t('Cancel') });
    const els = [...libEls, go, cancel];
    const note = blocked
      ? t('Close the game first: Steam restarts in the background to start the download.')
      : info.steamRunning
        ? t('Steam restarts in the background to start the download.')
        : '';
    const hints = h('div', { class: 'dlg-hints' });
    renderHints(hints, [
      ['confirm', 'Select'],
      ['back', 'Cancel'],
    ]);
    const root = h(
      'div',
      { class: 'overlay dialog-overlay' },
      h(
        'div',
        { class: 'dialog install-dialog' },
        h(
          'div',
          { class: 'id-head' },
          h('div', { class: 'id-cover' }, tileArt(game)),
          h(
            'div',
            { class: 'id-title' },
            h('div', { class: 'dlg-title', text: game.name }),
            h(
              'div',
              { class: 'id-sizes' },
              info.download ? h('span', { html: `${escapeHtml(t('Download size'))} <b>${escapeHtml(fmtBytes(info.download))}</b>` }) : null,
              info.size ? h('span', { html: `${escapeHtml(t('Space needed'))} <b>${escapeHtml(fmtBytes(info.size))}</b>` }) : null
            )
          )
        ),
        h('div', { class: 'id-label', text: t('Install To') }),
        h('div', { class: 'id-libs' }, ...libEls),
        note ? h('div', { class: 'dlg-msg id-note', text: note }) : null,
        h('div', { class: 'dlg-btns' }, go, cancel),
        hints
      )
    );
    const paint = () => libEls.forEach((el) => el.classList.toggle('on', el._lib.path === chosen));
    paint();
    const firstOn = Math.max(0, libEls.findIndex((el) => el._lib.path === chosen));
    const nav = new FocusList(els, { index: blocked ? els.length - 1 : els.indexOf(go) >= 0 ? els.indexOf(go) : firstOn });
    els.forEach((el, i) => {
      el.addEventListener('mouseenter', () => mouseActive() && !el.classList.contains('disabled') && nav.set(i));
      el.addEventListener('click', () => {
        nav.set(i);
        press();
      });
    });
    function press() {
      const el = nav.current;
      if (!el || el.classList.contains('disabled')) return sfx.bump();
      if (el === cancel) return done(null);
      if (el === go) return done(chosen);
      chosen = el._lib.path;
      sfx.toggle(true);
      paint();
    }
    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
          const d = action === 'up' || action === 'left' ? -1 : 1;
          if (nav.move(d)) sfx.move();
          else sfx.bump();
        } else if (action === 'confirm') press();
        else if (action === 'back') done(null);
        return true;
      },
      { dimApp: true }
    );
    sfx.open();
    function done(v) {
      v ? sfx.select() : sfx.back();
      ctl.close();
      resolve(v);
    }
  });
}

/* Tiles -------------------------------------------------------------- */

/** A progress bar (download under way) or a badge (update available) on a game tile. */
export function tileDownload(game) {
  const el = h('div', { class: 'tile-dl', dataset: { id: game.id } }, h('i'));
  paintTile(el, downloadFor(game));
  return el;
}

function paintTile(el, d) {
  const active = !!d && ACTIVE.has(d.status);
  el.classList.toggle('active', active);
  el.classList.toggle('available', !!d && (d.status === 'available' || d.status === 'error'));
  el.classList.toggle('paused', !!d && (d.status === 'paused' || d.status === 'queued'));
  el.classList.toggle('pulse', pulsing(d));
  el.firstChild.style.width = active ? `${Math.max(2, progressOf(d) * 100)}%` : '0';
  if (!!d && !active && !el.querySelector('.tdl-ic')) el.append(h('span', { class: 'tdl-ic', html: icon('download') }));
  else if ((!d || active) && el.querySelector('.tdl-ic')) el.querySelector('.tdl-ic').remove();
}

/** Bring every tile under root up to date. */
export function updateTileDownloads(root) {
  if (!root) return;
  root.querySelectorAll('.tile-dl').forEach((el) => paintTile(el, downloadFor(findGame(el.dataset.id))));
}

/** Changes worth rebuilding things for (status, not progress). */
export function downloadsSig() {
  return (state.downloads.items || []).map((d) => `${d.appid}:${d.status}`).join(',');
}
