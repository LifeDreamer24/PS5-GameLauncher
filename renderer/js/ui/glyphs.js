// Controller button prompts that follow the last-used input device.

import { getPromptStyle, getDevice } from '../input.js';
import { state, on } from '../state.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const PS_SHAPES = {
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="#3b6fd6" stroke-width="2.6" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0464f" stroke-width="2.4"><circle cx="12" cy="12" r="6.5"/></svg>',
  square: '<svg viewBox="0 0 24 24" fill="none" stroke="#d26fb6" stroke-width="2.4"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  triangle: '<svg viewBox="0 0 24 24" fill="none" stroke="#2bb39c" stroke-width="2.4" stroke-linejoin="round"><path d="M12 5.5l7 12H5z"/></svg>',
};

const ARROWS = `<span class="arrows">${icon('chevronLeft')}${icon('chevronRight')}</span>`;
const DPAD = `<span class="arrows">${icon('chevronLeft')}${icon('chevronRight')}</span>`;

const SCROLL_PAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/><path d="m10 7 2-2 2 2m-4 10 2 2 2-2"/></svg>';
const SCROLL_MOUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="2" width="14" height="20" rx="7"/><rect x="10" y="5" width="4" height="7" rx="2"/></svg>';

const MAP = {
  xbox: {
    confirm: ['A', 'round xa'],
    back: ['B', 'round xb'],
    x: ['X', 'round xx'],
    y: ['Y', 'round xy'],
    options: [icon('menu'), 'round'],
    guide: [icon('gamepad'), 'round'],
    select: [icon('grid'), 'round'],
    l1: ['LB', ''],
    r1: ['RB', ''],
    l2: ['LT', ''],
    r2: ['RT', ''],
    adjust: [DPAD, 'kb'],
    scroll: [SCROLL_PAD, 'round'],
  },
  ps: {
    confirm: [PS_SHAPES.cross, 'round'],
    back: [PS_SHAPES.circle, 'round'],
    x: [PS_SHAPES.square, 'round'],
    y: [PS_SHAPES.triangle, 'round'],
    options: [icon('menu'), 'round'],
    guide: ['PS', ''],
    select: [icon('grid'), 'round'],
    l1: ['L1', ''],
    r1: ['R1', ''],
    l2: ['L2', ''],
    r2: ['R2', ''],
    adjust: [DPAD, 'kb'],
    scroll: [SCROLL_PAD, 'round'],
  },
  keyboard: {
    confirm: ['Enter', 'kb'],
    back: ['Esc', 'kb'],
    x: ['X', 'kb'],
    y: ['F', 'kb'],
    options: ['O', 'kb'],
    guide: ['Home', 'kb'],
    select: ['Tab', 'kb'],
    l1: ['Q', 'kb'],
    r1: ['E', 'kb'],
    l2: ['PgUp', 'kb'],
    r2: ['PgDn', 'kb'],
    adjust: [ARROWS, 'kb'],
    scroll: ['↑ ↓', 'kb'],
  },
};

export function glyph(action) {
  const pref = state.settings.prompts;
  if (action === 'scroll' && (!pref || pref === 'auto') && getDevice() === 'mouse') {
    return `<span class="glyph round">${SCROLL_MOUSE}</span>`;
  }
  const style = getPromptStyle(pref);
  const [content, cls] = (MAP[style] || MAP.keyboard)[action] || ['?', 'kb'];
  return `<span class="glyph ${cls}">${content}</span>`;
}

export function renderHints(el, list) {
  el._hints = list;
  el.classList.add('hints');
  el.innerHTML = list.map(([action, label]) => `<span class="hint">${glyph(action)}<span>${t(label)}</span></span>`).join('');
}

function refreshAll() {
  document.querySelectorAll('.hints').forEach((el) => {
    if (el._hints) renderHints(el, el._hints);
  });
  document.querySelectorAll('[data-glyph]').forEach((el) => {
    el.innerHTML = glyph(el.dataset.glyph);
  });
}

on('device', refreshAll);
on('settings', (k) => {
  if (k === 'prompts' || k === null) refreshAll();
});
