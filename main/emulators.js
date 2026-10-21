// Emulators: their games join the library like any other. For now the Nintendo
// Switch, through yuzu and its forks (Eden, Citron, Sudachi, Torzu, suyu): the
// user picks the emulator's program, and its games come from the game folders
// set in the emulator itself (user\config\qt-config.ini, in the portable
// "user" folder next to the program or in %APPDATA%\<name>).
//
// Names and artwork come from Nintendo's own game search (the one
// nintendo.com uses), looked up by the title ID most ROM files carry.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { hashId, tidyName } = require('./scanner');

// yuzu and the forks that keep its config layout, by program name.
const YUZU_FORKS = { eden: 'Eden', citron: 'Citron', sudachi: 'Sudachi', torzu: 'Torzu', suyu: 'suyu', yuzu: 'yuzu' };
// What their game list shows from a game folder (installed NAND titles aside).
const ROM_EXT = new Set(['.nsp', '.xci', '.nro']);
// Game folders that are the emulator's own storage, not folders on the PC.
const SPECIAL_DIRS = new Set(['sdmc', 'usernand', 'sysnand']);

/* ------------------------------------------------------------------ */
/* The emulator and its configuration                                  */
/* ------------------------------------------------------------------ */

/** A QSettings .ini value: quotes and backslash escapes undone. */
function iniValue(raw) {
  const s = String(raw).trim();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') continue;
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      if (n === 'x') {
        let hex = '';
        while (hex.length < 4 && /[0-9a-f]/i.test(s[i + 1] || '')) hex += s[++i];
        out += String.fromCharCode(parseInt(hex || '0', 16));
      } else out += { n: '\n', t: '\t', r: '\r', 0: '\0' }[n] ?? n;
      continue;
    }
    out += c;
  }
  return out;
}

/** One section of a QSettings .ini file as key -> value. */
function iniSection(text, name) {
  const out = new Map();
  let inside = false;
  for (const line of String(text).split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) {
      inside = decodeURIComponent(sec[1]) === name;
      continue;
    }
    if (!inside) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out.set(line.slice(0, eq).trim(), iniValue(line.slice(eq + 1)));
  }
  return out;
}

/**
 * What a picked program is: a yuzu-family emulator, where it keeps its
 * settings (portable or in AppData) and the game folders set in it.
 */
async function detectSwitch(exe) {
  const out = { exe, name: null, userDir: null, portable: false, gameDirs: [], error: null };
  if (!exe || !/\.exe$/i.test(exe) || !fs.existsSync(exe)) {
    out.error = 'The program isn’t there any more.';
    return out;
  }
  const base = path.basename(exe, '.exe').toLowerCase();
  const fork = Object.keys(YUZU_FORKS).find((k) => base === k || base.startsWith(`${k}-`) || base.startsWith(`${k}_`) || base.startsWith(`${k}.`));
  out.name = fork ? YUZU_FORKS[fork] : path.basename(exe, '.exe');
  const portable = path.join(path.dirname(exe), 'user');
  const appData = process.env.APPDATA || '';
  const candidates = [
    portable,
    ...[...new Set([base, fork, ...Object.keys(YUZU_FORKS)].filter(Boolean))].map((n) => path.join(appData, n)),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'config', 'qt-config.ini'))) {
      out.userDir = dir;
      out.portable = dir === portable;
      break;
    }
  }
  if (!out.userDir) {
    out.error = fork ? 'Start it once, set up its game folders, then scan again.' : 'This doesn’t look like a yuzu-based emulator.';
    return out;
  }
  let text = '';
  try {
    text = await fsp.readFile(path.join(out.userDir, 'config', 'qt-config.ini'), 'utf8');
  } catch {
    out.error = 'Its settings couldn’t be read.';
    return out;
  }
  const ui = iniSection(text, 'UI');
  const n = Number(ui.get('Paths\\gamedirs\\size')) || 0;
  for (let i = 1; i <= n; i++) {
    const p = ui.get(`Paths\\gamedirs\\${i}\\path`);
    if (!p || SPECIAL_DIRS.has(p.toLowerCase())) continue;
    out.gameDirs.push({ path: path.normalize(p), deep: ui.get(`Paths\\gamedirs\\${i}\\deep_scan`) === 'true' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ROM files                                                           */
/* ------------------------------------------------------------------ */

/** The title ID in a file name, e.g. "Mario Kart 8 Deluxe [0100152000022000][v0].nsp". */
function titleIdFromName(file) {
  const m = /\[(0[14][0-9a-f]{14})\]/i.exec(file) || /(?:^|[^0-9a-f])(0[14][0-9a-f]{14})(?:[^0-9a-f]|$)/i.exec(file);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The title ID inside an NSP: it is a PFS0 archive, and its ticket is named
 * after the rights ID (title ID + key generation). Encrypted parts aren't read.
 */
async function titleIdFromNsp(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    if (head.toString('latin1', 0, 4) !== 'PFS0') return null;
    const count = head.readUInt32LE(4);
    const strSize = head.readUInt32LE(8);
    if (!count || count > 4096 || strSize > 1 << 20) return null;
    const size = count * 24 + strSize;
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 16);
    const names = buf.toString('latin1', count * 24, size).split('\0');
    for (const n of names) {
      const m = /^(0[14][0-9a-f]{14})[0-9a-f]{16}\.(tik|cert)$/i.exec(n);
      if (m) return m[1].toUpperCase();
    }
  } catch {
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return null;
}

/** A game's name from its file name, without the tags around it. */
function nameFromRom(file) {
  const n = path
    .basename(file, path.extname(file))
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/\bv\d{3,}\b/gi, ' ')
    .replace(/_+/g, ' ')
    .replace(/\s+[-–]\s*$/, '');
  return tidyName(n);
}

/** Base games only: updates end in 800, add-ons in anything but 000. */
const isBaseTitle = (id) => !id || /000$/.test(id);

async function romFiles(dir, deep, depth = 0, budget = { n: 0 }) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (++budget.n > 20000) break;
    const full = path.join(dir, e.name);
    if (e.isFile() && ROM_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    else if (deep && e.isDirectory() && depth < 6) out.push(...(await romFiles(full, deep, depth + 1, budget)));
  }
  return out;
}

/**
 * The emulator's games, ready for the library. Each starts the emulator with
 * the ROM (-g), in full screen (-f) unless switched off.
 */
async function scanSwitch(conf) {
  if (!conf || !conf.exe) return { found: false, info: null, games: [] };
  const info = await detectSwitch(conf.exe);
  if (info.error) return { found: false, info, games: [] };
  const games = [];
  const seen = new Set();
  for (const d of info.gameDirs) {
    for (const file of await romFiles(d.path, d.deep)) {
      const ext = path.extname(file).toLowerCase();
      const titleId = titleIdFromName(path.basename(file)) || (ext === '.nsp' ? await titleIdFromNsp(file) : null);
      if (!isBaseTitle(titleId)) continue;
      const id = titleId ? `switch-${titleId.toLowerCase()}` : hashId('switch', file);
      if (seen.has(id)) continue; // the same game twice (an .nsp and an .xci, say)
      seen.add(id);
      games.push({
        id,
        name: nameFromRom(file) || path.basename(file),
        source: 'emulator',
        platform: 'switch',
        emulator: info.name,
        titleId,
        path: file,
        exe: conf.exe,
        launch: { type: 'exe', target: conf.exe, args: `${conf.fullscreen === false ? '' : '-f '}-g "${file}"`, cwd: path.dirname(conf.exe) },
      });
    }
  }
  return { found: true, info, games };
}

/** The ROM a shortcut to the emulator starts (its -g argument), lower-case, for matching. */
function romOfLaunch(launch) {
  if (!launch || launch.type !== 'exe' || !launch.args) return null;
  const m = /(?:^|\s)-g\s+(?:"([^"]+)"|(\S+))/.exec(launch.args);
  const p = m && (m[1] || m[2]);
  return p ? path.normalize(p).toLowerCase() : null;
}

/* ------------------------------------------------------------------ */
/* Names and artwork (Nintendo's game search)                          */
/* ------------------------------------------------------------------ */

const NINTENDO_SEARCH = 'https://searching.nintendo-europe.com/en/select';
const FIELDS = 'title,application_id_s,image_url,image_url_sq_s,image_url_h2x1_s,excerpt,publisher,developer,date_from,pretty_game_categories_txt,system_type';

async function nintendoQuery(q, fq, rows) {
  const u = new URL(NINTENDO_SEARCH);
  u.search = new URLSearchParams({ q, fq, rows: String(rows), wt: 'json', fl: FIELDS }).toString();
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PS5GameLauncher/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.response && j.response.docs) || [];
}

/** Nintendo's entry for a Switch game: by title ID, else by name. */
async function nintendoLookup(g, scoreMatch) {
  if (g.titleId) {
    const docs = await nintendoQuery('*', `type:GAME AND application_id_s:(${g.titleId} OR ${g.titleId.toLowerCase()})`, 1);
    if (docs[0]) return docs[0];
  }
  const term = String(g.name || '').replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
  if (!term) return null;
  const docs = await nintendoQuery(term, 'type:GAME AND system_type:nintendoswitch*', 8);
  let best = null;
  for (const [rank, d] of docs.entries()) {
    const s = scoreMatch(g.name, d.title || '', rank);
    if (!best || s > best.s) best = { d, s };
  }
  return best && best.s >= 0.8 ? best.d : null;
}

/** Bigger versions first where Nintendo has them (only the wide image has a 1600 px one). */
const sizes = (url) => (url ? [url.replace(/_image500w\.(jpg|png)$/i, '_image1600w.$1'), url].filter((u, i, a) => a.indexOf(u) === i) : []);

function nintendoCandidates(d) {
  const wide = d.image_url_h2x1_s;
  // image_url is the box art (a packshot) for most games, the square image for some.
  const box = d.image_url && /packshot|\/PS_/i.test(d.image_url) ? d.image_url : null;
  return {
    grid: sizes(d.image_url_sq_s),
    hero: sizes(wide),
    banner: sizes(wide),
    capsule: box ? [box] : [],
    logo: [],
  };
}

function nintendoMeta(d) {
  return {
    title: d.title || null,
    description: d.excerpt || '',
    developer: d.developer || '',
    publisher: d.publisher || '',
    franchise: '',
    genres: d.pretty_game_categories_txt || [],
    released: d.date_from ? Date.parse(d.date_from) || null : null,
  };
}

/* ------------------------------------------------------------------ */
/* Players: which controller each one uses                             */
/* ------------------------------------------------------------------ */
// The emulator reads controllers through SDL and keeps each player's buttons
// as SDL bindings with the device's GUID and a port (the n-th device with that
// GUID), e.g. "engine:sdl,port:0,guid:030000004c050000e60c000000016800,button:1".
// The buttons are SDL gamepad buttons (A, B, X, Y…), the same on every
// controller, so giving a player another controller only means another GUID.
//
// SDL's GUID (CRC left out, as yuzu does): bus, vendor, product, version,
// driver ('h' HIDAPI for PlayStation pads, 'x' XInput for the rest) and data
// (the XInput subtype). Checked against the GUIDs Eden saved for a DualSense
// and a GameSir pad (2026-10-19).

const VIRTUAL = {
  // What the launcher's controller passthrough gives games (measured 2026-10-19).
  dualsense: { bus: 3, vid: 0x054c, pid: 0x0ce6, version: 0x0100, driver: 'h' },
  dualsenseedge: { bus: 3, vid: 0x054c, pid: 0x0df2, version: 0x0100, driver: 'h' },
  dualshock4: { bus: 3, vid: 0x054c, pid: 0x09cc, version: 0x0100, driver: 'h' },
  xbox360: { bus: 3, vid: 0x045e, pid: 0x028e, version: 0x0114, driver: 'x', data: 1 },
};

function sdlGuid({ bus, vid, pid, version, driver, data = 0 }) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(bus, 0);
  b.writeUInt16LE(vid, 4);
  b.writeUInt16LE(pid, 8);
  b.writeUInt16LE(version, 12);
  b[14] = driver.charCodeAt(0);
  b[15] = data;
  return b.toString('hex');
}

const XBOX_PIDS = {
  0x028e: 'Xbox 360 Controller',
  0x02d1: 'Xbox One Controller',
  0x02dd: 'Xbox One Controller',
  0x02ea: 'Xbox One Controller',
  0x02e3: 'Xbox Elite Controller',
  0x0b00: 'Xbox Elite Series 2 Controller',
  0x0b05: 'Xbox Elite Series 2 Controller',
  0x0b22: 'Xbox Elite Series 2 Controller',
  0x0b12: 'Xbox Series X|S Controller',
  0x0b13: 'Xbox Series X|S Controller',
  0x0b20: 'Xbox Series X|S Controller',
};
const VENDORS = { 0x3537: 'GameSir', 0x2dc8: '8BitDo', 0x0e6f: 'PDP', 0x24c6: 'PowerA', 0x20d6: 'PowerA', 0x0f0d: 'HORI', 0x1532: 'Razer', 0x046d: 'Logitech', 0x0738: 'Mad Catz', 0x11c0: 'Betop', 0x2563: 'ShanWan' };
const PS_NAMES = { 0x0ce6: 'DualSense', 0x0df2: 'DualSense Edge', 0x05c4: 'DualShock 4', 0x09cc: 'DualShock 4' };

/** A name people know the controller by. */
function padName(p) {
  if (p.kind === 'ps') return `${PS_NAMES[p.pid] || 'PlayStation Controller'} (${p.bus === 'bluetooth' ? 'Bluetooth' : 'USB'})`;
  if (p.vid === 0x045e) return XBOX_PIDS[p.pid] || 'Xbox Controller';
  // XInput's own name, unless it is the generic one Windows gives every Xbox-style pad.
  const inner = /\(([^)]+)\)/.exec(p.product || '');
  const own = inner && !/xbox (360|one) (controller )?for windows/i.test(inner[1]) ? inner[1] : null;
  return own || `${VENDORS[p.vid] || 'Xbox-Style'} Controller`;
}

/** The connected controllers (from the helper's "gamepads"), each with a lasting id and a name. */
function describePads(raw) {
  const seen = new Map();
  return (raw || []).map((p) => {
    let id = p.kind === 'ps' ? (p.mac ? `ps:${p.mac}` : `ps:${p.vid}:${p.pid}:${p.bus}`) : `xi:${p.vid}:${p.pid}`;
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `#${n}`;
    return { ...p, id, name: padName(p) };
  });
}

/**
 * The GUID the emulator sees for a controller. pass: controller passthrough
 * is on for the game ({ emulation }), so the emulator gets the launcher's
 * virtual pad instead (DualSense pads become the chosen kind, Xbox-style ones
 * an Xbox 360 pad).
 */
function edenGuid(p, pass) {
  const dualSense = p.kind === 'ps' && (p.pid === 0x0ce6 || p.pid === 0x0df2);
  if (pass && p.kind === 'xinput') return sdlGuid(VIRTUAL.xbox360);
  if (pass && dualSense) return sdlGuid(VIRTUAL[pass.emulation === 'dualsense' && p.pid === 0x0df2 ? 'dualsenseedge' : pass.emulation] || VIRTUAL.dualsense);
  if (p.kind === 'xinput') return sdlGuid({ bus: 3, vid: p.vid, pid: p.pid, version: p.version, driver: 'x', data: p.subtype || 1 });
  return sdlGuid({ bus: p.bus === 'bluetooth' ? 5 : 3, vid: p.vid, pid: p.pid, version: p.version, driver: 'h' });
}

// A player's controls, as yuzu sets them up for a gamepad (Nintendo layout: A is the right-hand button).
const PLAYER_KEYS = {
  button_a: 'button:1',
  button_b: 'button:0',
  button_x: 'button:3',
  button_y: 'button:2',
  button_lstick: 'button:7',
  button_rstick: 'button:8',
  button_l: 'button:9',
  button_r: 'button:10',
  button_zl: 'axis:4,threshold:0.5,invert:+',
  button_zr: 'axis:5,threshold:0.5,invert:+',
  button_plus: 'button:6',
  button_minus: 'button:4',
  button_dleft: 'button:13',
  button_dup: 'button:11',
  button_dright: 'button:14',
  button_ddown: 'button:12',
  button_slleft: 'button:9',
  button_srleft: 'button:10',
  button_home: 'button:5',
  button_screenshot: 'button:15',
  button_slright: 'button:9',
  button_srright: 'button:10',
  lstick: 'axis_x:0,axis_y:1,offset_x:0.000000,offset_y:0.000000,invert_x:+,invert_y:+',
  rstick: 'axis_x:2,axis_y:3,offset_x:0.000000,offset_y:0.000000,invert_x:+,invert_y:+',
  motionleft: null, // motion: 'engine:sdl,motion:0,port:…,guid:…'
  motionright: null,
};

const unquote = (v) => String(v || '').replace(/^"|"$/g, '');
const isSdl = (v) => /^engine:sdl,/.test(unquote(v));

/** A binding for another device: the same buttons, the new GUID and port. */
function retarget(binding, guid, port) {
  return unquote(binding)
    .replace(/(^|,)port:\d+/, `$1port:${port}`)
    .replace(/(^|,)guid:[0-9a-f]+/i, `$1guid:${guid}`);
}

/**
 * Point players at controllers in qt-config.ini's [Controls]: each given
 * player gets a { guid, port } (keeping its own button choices when it was
 * set up for a controller already) or 'off' (not connected). Players not
 * given stay as the emulator has them. Values get "\default=false", or the
 * emulator would use its defaults instead.
 */
async function writeSwitchPlayers(userDir, players) {
  const file = path.join(userDir, 'config', 'qt-config.ini');
  const text = await fsp.readFile(file, 'utf8');
  const backup = `${file}.launcher-backup`;
  if (!fs.existsSync(backup)) await fsp.writeFile(backup, text);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '[Controls]');
  if (start < 0) throw new Error('The emulator’s settings have no controls yet. Start it once first.');
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  const index = new Map();
  for (let i = start + 1; i < end; i++) {
    const eq = lines[i].indexOf('=');
    if (eq > 0) index.set(lines[i].slice(0, eq), i);
  }
  const get = (k) => (index.has(k) ? lines[index.get(k)].slice(k.length + 1) : null);
  const added = [];
  const set = (k, v) => {
    for (const [key, val] of [[k, v], [`${k}\\default`, 'false']]) {
      if (index.has(key)) lines[index.get(key)] = `${key}=${val}`;
      else added.push(`${key}=${val}`);
    }
  };
  // Button choices to start from: the player's own, else player 1's, else yuzu's.
  const sdlTemplate = (n) => (isSdl(get(`player_${n}_button_a`)) ? n : isSdl(get('player_0_button_a')) ? 0 : -1);
  for (const [n, want] of Object.entries(players)) {
    if (want === 'off') {
      set(`player_${n}_connected`, 'false');
      continue;
    }
    const from = sdlTemplate(Number(n));
    for (const [key, def] of Object.entries(PLAYER_KEYS)) {
      const own = from >= 0 ? get(`player_${from}_${key}`) : null;
      let value;
      if (own && isSdl(own)) value = retarget(own, want.guid, want.port);
      else if (def) value = `engine:sdl,port:${want.port},guid:${want.guid},${def}`;
      else value = `engine:sdl,motion:0,port:${want.port},guid:${want.guid}`;
      set(`player_${n}_${key}`, `"${value}"`);
    }
    set(`player_${n}_connected`, 'true');
    if (get(`player_${n}_type`) == null) set(`player_${n}_type`, '0');
  }
  // New keys go at the end of the section (before its blank line).
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, ...added);
  await fsp.writeFile(file, lines.join(nl));
}

module.exports = {
  YUZU_FORKS,
  detectSwitch,
  scanSwitch,
  romOfLaunch,
  nintendoLookup,
  nintendoCandidates,
  nintendoMeta,
  iniSection,
  titleIdFromNsp,
  nameFromRom,
  sdlGuid,
  describePads,
  edenGuid,
  writeSwitchPlayers,
};
