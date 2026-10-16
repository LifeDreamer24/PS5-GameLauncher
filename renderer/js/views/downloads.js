// Downloads: Steam updates under way, queued and failed, laid out like the
// PS5's Downloads/Uploads screen (sections on the left, one row per game with
// its cover, sizes, time left and a progress bar on the right).

import { h, escapeHtml, clamp } from '../util.js';
import { icon } from '../icons.js';
import { state, on, api, artUrl, findGame } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { FocusList } from '../ui/overlay.js';
import { optionsMenu } from '../ui/dialogs.js';
import { renderHints } from '../ui/glyphs.js';
import { tileArt } from '../ui/tiles.js';
import { ACTIVE, statusText, progressOf, sizeLine, fmtSpeed, startUpdate, pulsing } from '../ui/downloads.js';
import { t } from '../i18n.js';

const SECTIONS = [
  { id: 'downloads', label: 'Downloads' },
  { id: 'errors', label: 'Errors' },
];

const listFor = (id) => (state.downloads.items || []).filter((d) => (id === 'errors' ? d.status === 'error' : ACTIVE.has(d.status)));

export class DownloadsView {
  constructor(router) {
    this.router = router;
    this.name = 'downloads';
    this.usesHero = false;
    this.section = 'downloads';
    this.zone = 'nav';
    this.rows = [];
    this.build();
    on('downloads', () => this.active && this.update());
    on('games', () => this.active && this.render(true));
  }

  build() {
    this.navEls = SECTIONS.map((s, i) =>
      h(
        'button',
        {
          class: 'dl-nav-item fx',
          onclick: () => {
            this.navNav.set(i);
            this.setSection(s.id);
            this.setZone('nav');
          },
          onmouseenter: () => mouseActive() && this.setZone('nav', i),
        },
        h('span', { text: t(s.label) }),
        h('em', { class: 'dl-count' })
      )
    );
    this.navNav = new FocusList(this.navEls);
    this.list = h('div', { class: 'dl-list' });
    this.hints = h('div', { class: 'dl-hints' });
    renderHints(this.hints, [
      ['confirm', 'Select'],
      ['options', 'Options'],
      ['back', 'Back'],
    ]);
    this.el = h(
      'section',
      { class: 'view dl-view' },
      h('div', { class: 'dl-title', text: t('Downloads') }),
      h('nav', { class: 'dl-nav' }, this.navEls[0], this.navEls[1]),
      h('div', { class: 'dl-list-wrap' }, this.list),
      this.hints
    );
    // A divider between the sections, like the PS5's.
    this.navEls[0].after(h('i', { class: 'dl-nav-sep' }));
    this.listNav = new FocusList([]);
  }

  /* ---------------------------------------------------------------- */

  render(keep = false) {
    const prev = keep && this.rows[this.listNav.index] ? this.rows[this.listNav.index].appid : null;
    this.rows = listFor(this.section);
    this.sig = this.rows.map((d) => `${d.appid}:${d.status}:${d.gameId}`).join(',');
    this.navEls.forEach((el, i) => {
      el.classList.toggle('active', SECTIONS[i].id === this.section);
      const n = listFor(SECTIONS[i].id).length;
      el.querySelector('.dl-count').textContent = n ? String(n) : '';
    });
    const els = [];
    let lastGame = null;
    const frag = [];
    for (const d of this.rows) {
      // The game's name above its rows (one row per game for Steam).
      if (d.name !== lastGame) frag.push(h('div', { class: 'dl-group', text: d.name }));
      lastGame = d.name;
      const g = d.gameId ? findGame(d.gameId) : null;
      const cover = g ? h('div', { class: 'dl-cover' }, tileArt(g)) : h('div', { class: 'dl-cover empty', html: icon('download') });
      const row = h(
        'button',
        {
          class: 'dl-row fx',
          onmouseenter: () => mouseActive() && this.setZone('list', els.indexOf(row)),
          onclick: () => {
            this.setZone('list', els.indexOf(row));
            this.rowMenu(d, row);
          },
        },
        cover,
        h(
          'div',
          { class: 'dl-info' },
          h('div', { class: 'dl-name', text: d.name }),
          h('div', { class: 'dl-line' }, h('span', { class: 'dl-state' }), h('span', { class: 'dl-size' })),
          h('div', { class: 'dl-line dl-line2' }, h('span', { class: 'dl-sub' }), h('span', { class: 'dl-speed' })),
          h('div', { class: 'dl-bar' }, h('i'))
        )
      );
      row._appid = d.appid;
      els.push(row);
      frag.push(row);
    }
    if (!els.length) {
      frag.push(
        h('div', {
          class: 'dl-empty',
          text: t(this.section === 'errors' ? 'No errors.' : 'Nothing is downloading. Steam updates show here while they download.'),
        })
      );
    }
    this.list.replaceChildren(...frag);
    let idx = prev ? this.rows.findIndex((d) => d.appid === prev) : 0;
    if (idx < 0) idx = clamp(this.listNav.index || 0, 0, Math.max(0, els.length - 1));
    this.listNav = new FocusList(els, { index: idx, onChange: (el) => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) });
    if (!els.length && this.zone === 'list') this.zone = 'nav';
    this.paint();
    this.applyZone();
  }

  /** Progress and sizes in place (they change every second while downloading). */
  paint() {
    const byId = new Map((state.downloads.items || []).map((d) => [d.appid, d]));
    for (const row of this.listNav.els) {
      const d = byId.get(row._appid);
      if (!d) continue;
      const active = d.status === 'downloading' || d.status === 'installing';
      row.querySelector('.dl-state').textContent = statusText(d);
      row.querySelector('.dl-size').textContent = d.status === 'error' ? '' : sizeLine(d);
      row.querySelector('.dl-sub').textContent = d.status === 'downloading' && d.speed ? t('Download speed') : d.status === 'installing' ? t('Installing the update') : '';
      row.querySelector('.dl-speed').textContent = d.status === 'downloading' ? fmtSpeed(d.speed) : '';
      row.querySelector('.dl-bar').style.visibility = d.status === 'error' ? 'hidden' : '';
      row.querySelector('.dl-bar i').style.width = `${Math.max(active ? 1 : 0, progressOf(d) * 100)}%`;
      row.querySelector('.dl-bar').classList.toggle('pulse', pulsing(d));
      row.classList.toggle('waiting', !active);
      row.classList.toggle('error', d.status === 'error');
    }
  }

  update() {
    const rows = listFor(this.section);
    const sig = rows.map((d) => `${d.appid}:${d.status}:${d.gameId}`).join(',');
    if (sig !== this.sig) this.render(true);
    else this.paint();
    this.navEls.forEach((el, i) => {
      const n = listFor(SECTIONS[i].id).length;
      el.querySelector('.dl-count').textContent = n ? String(n) : '';
    });
  }

  setSection(id) {
    if (id === this.section) return;
    this.section = id;
    sfx.select();
    this.listNav = new FocusList([]);
    this.render();
  }

  setZone(zone, index = null) {
    if (zone === 'list' && !this.listNav.els.length) return;
    if (zone !== this.zone) sfx.move();
    this.zone = zone;
    if (index !== null) (zone === 'nav' ? this.navNav : this.listNav).set(index, { silent: true });
    this.applyZone();
  }

  applyZone() {
    this.navNav.blur();
    this.listNav.blur();
    if (this.zone === 'nav') this.navNav.refocus();
    else this.listNav.refocus();
  }

  async rowMenu(d, anchor) {
    const g = d.gameId ? findGame(d.gameId) : null;
    await optionsMenu({
      title: d.name,
      anchor,
      items: [
        d.status === 'paused' || d.status === 'error' ? { label: d.status === 'error' ? 'Try Again' : 'Resume', icon: 'download', run: () => g && startUpdate(g) } : null,
        g ? { label: 'Go to Game', icon: 'gamepad', run: () => this.router.open('hub', { id: g.id }) } : null,
        { label: 'Open Steam Downloads', icon: 'steam', run: () => api.downloadsOpenSteam() },
      ].filter(Boolean),
    });
  }

  handle(action) {
    if (this.zone === 'nav') {
      if (action === 'up' || action === 'down') {
        if (this.navNav.move(action === 'up' ? -1 : 1)) {
          sfx.move();
          this.setSection(SECTIONS[this.navNav.index].id);
        } else sfx.bump();
      } else if (action === 'right' || action === 'confirm') {
        if (this.listNav.els.length) this.setZone('list');
        else sfx.bump();
      } else if (action === 'left') sfx.bump();
      else return false;
      return true;
    }
    const d = this.rows[this.listNav.index];
    switch (action) {
      case 'up':
      case 'down':
        if (this.listNav.move(action === 'up' ? -1 : 1)) sfx.move();
        else sfx.bump();
        return true;
      case 'left':
        this.setZone('nav');
        return true;
      case 'right':
        sfx.bump();
        return true;
      case 'confirm':
      case 'options':
        if (d) this.rowMenu(d, this.listNav.current);
        return true;
      case 'back':
        sfx.back();
        this.setZone('nav');
        return true;
    }
    return false;
  }

  show(params = {}) {
    this.active = true;
    if (params.section) this.section = params.section;
    // Opened for a download: start on the list, on that game.
    this.zone = listFor(this.section).length ? 'list' : 'nav';
    this.navNav.set(Math.max(0, SECTIONS.findIndex((s) => s.id === this.section)), { silent: true });
    this.listNav = new FocusList([]);
    this.render();
    if (params.appid) {
      const i = this.rows.findIndex((r) => r.appid === String(params.appid));
      if (i >= 0) this.listNav.set(i, { silent: true });
      this.applyZone();
    }
  }

  hide() {
    this.active = false;
  }
}
