// Settings › Storage › Games and Apps, like the PS5's storage screens: the
// PC's drives, the games installed on each with their size, and deleting them.
// Steam games are uninstalled the way Steam does it (main/steamdownloads.js);
// a PC game's folder is only deleted when it is clearly that game's own.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const { similarity } = require('./scanner');

const LAUNCHERS = { epic: 'Epic Games Launcher', ubisoft: 'Ubisoft Connect', xbox: 'the Xbox app' };
const SHORTCUT = /\.(lnk|url)$/i;

const lower = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
/** a is b, or b is inside a. */
const contains = (a, b) => {
  const x = lower(a);
  const y = lower(b);
  return y === x || y.startsWith(x + path.sep);
};

/** Bytes in a folder (files only; links and junctions aren't followed), or in one file. */
async function folderSize(dir) {
  try {
    const st = await fsp.lstat(dir);
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (e.isFile()) files.push(path.join(d, e.name));
    }
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(files.slice(i, i + 64).map((f) => fsp.lstat(f).then((s) => s.size, () => 0)));
      for (const n of sizes) total += n;
    }
  }
  return total;
}

class Storage {
  constructor({ library, system, steam, monitor, settings, dataDir, send }) {
    this.library = library;
    this.system = system;
    this.steam = steam;
    this.monitor = monitor;
    this.settings = settings;
    this.send = send;
    this.cacheFile = path.join(dataDir, 'game-sizes.json');
    this.sizes = new Map(); // lower(root) -> bytes
    this.measured = new Set(); // roots measured since the launcher started
    this.measuring = null;
    this.deleting = false;
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')))) this.sizes.set(k, Number(v) || 0);
    } catch {}
  }

  /** Folders a game folder may never be (or contain): system, user and library roots. */
  protectedPaths() {
    const env = process.env;
    const home = os.homedir();
    const list = [
      env.SystemRoot || 'C:\\Windows',
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramData,
      path.dirname(home),
      home,
      ...['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'AppData'].map((d) => path.join(home, d)),
      ...(this.settings.data.folders || []),
    ];
    if (this.steam && this.steam.steamPath) list.push(this.steam.steamPath, ...(this.steam.libs || []).flatMap((l) => [l, path.join(l, 'common'), path.dirname(l)]));
    return list.filter(Boolean);
  }

  /** The program a shortcut or manually added game starts. */
  static exeOf(g) {
    const t = g.exe || (g.launch && g.launch.type === 'exe' ? g.launch.target : '');
    return t && path.isAbsolute(t) ? t : '';
  }

  /**
   * Where a game lives and whether the launcher may delete it.
   * PC games added as shortcuts point at their program; their folder is the
   * outermost folder above it named like the game (e.g. G:\Cyberpunk 2077 for
   * G:\Cyberpunk 2077\Cyberpunk 2077\bin\x64\Cyberpunk2077.exe). It is not
   * deletable when that can't be told, when the program is shared (one
   * emulator for several games), or when the folder holds other games or a
   * system or library folder.
   */
  locate(g, games, guard) {
    if (g.installed === false) return null;
    if (g.source === 'steam') {
      if (!g.installDir || path.basename(g.installDir).toLowerCase() === 'common' || !fs.existsSync(g.installDir)) return null;
      return { root: g.installDir, deletable: true };
    }
    // An emulated game is its ROM file (the emulator is shared, never deleted).
    if (g.source === 'emulator') {
      if (!g.path || !fs.existsSync(g.path)) return null;
      return { root: g.path, deletable: true };
    }
    if (LAUNCHERS[g.source]) {
      if (!g.installDir || !fs.existsSync(g.installDir)) return null;
      return { root: g.installDir, deletable: false, reason: 'launcher', launcher: LAUNCHERS[g.source] };
    }
    const exe = Storage.exeOf(g);
    let root = null;
    if (g.source === 'folder' && g.installDir && !SHORTCUT.test(g.path || '')) root = g.installDir;
    else if (exe) {
      for (let dir = path.dirname(exe); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (similarity(path.basename(dir), g.name) >= 0.5) root = dir;
      }
    }
    if (!exe && !root) return null; // a link to a website or a store: nothing on disk
    const where = root || exe;
    if (!fs.existsSync(where)) return null;
    if (exe && games.some((o) => o !== g && lower(Storage.exeOf(o)) === lower(exe))) return { root: null, drive: where, deletable: false, reason: 'shared' };
    if (!root) return { root: null, drive: where, deletable: false, reason: 'unknown' };
    const others = games.filter((o) => o !== g && o.installed !== false).flatMap((o) => [o.installDir, Storage.exeOf(o)]).filter(Boolean);
    const unsafe =
      path.parse(root).root.toLowerCase() === lower(root) + path.sep ||
      guard.some((p) => contains(root, p) || lower(p) === lower(root)) ||
      others.some((p) => contains(root, p));
    return unsafe ? { root, deletable: false, reason: 'unknown' } : { root, deletable: true };
  }

  async drives() {
    let list = null;
    try {
      list = await this.system.request('drives', {}, 5000);
    } catch {}
    if (!Array.isArray(list)) {
      // Without the helper: every drive letter that answers.
      list = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        try {
          const st = await fsp.statfs(`${l}:\\`);
          list.push({ root: `${l}:\\`, label: '', total: Number(st.blocks) * Number(st.bsize), free: Number(st.bavail) * Number(st.bsize) });
        } catch {}
      }
    }
    return list.map((d) => ({ ...d, letter: d.root.slice(0, 2).toUpperCase() }));
  }

  /** Drives and installed games, with the sizes known so far (the rest are measured in the background). */
  async info() {
    const games = this.library.games;
    const guard = this.protectedPaths();
    const running = new Set(this.monitor.list().map((r) => r.id));
    const items = [];
    for (const g of games) {
      const at = this.locate(g, games, guard);
      if (!at) continue;
      const key = at.root ? lower(at.root) : null;
      let size = null;
      if (g.source === 'steam' && g.sizeOnDisk > 0) size = g.sizeOnDisk;
      else if (key && this.sizes.has(key)) size = this.sizes.get(key);
      items.push({
        id: g.id,
        name: g.name,
        source: g.source,
        category: g.category || 'game',
        root: at.root,
        drive: path.parse(at.root || at.drive).root.slice(0, 2).toUpperCase(),
        size,
        lastUsed: Math.max(g.lastPlayed || 0, g.steamLastPlayed || 0),
        addedAt: g.addedAt || 0,
        running: running.has(g.id),
        deletable: at.deletable,
        reason: at.reason || null,
        launcher: at.launcher || null,
      });
    }
    this.measure(items);
    const drives = (await this.drives()).map((d) => {
      const on = items.filter((it) => it.drive === d.letter);
      return { ...d, count: on.length, games: on.reduce((n, it) => n + (it.size || 0), 0) };
    });
    return { drives, games: items, deleting: this.deleting };
  }

  /** Folder sizes not measured yet in this run: one after another, telling the window as they come in. */
  measure(items) {
    const todo = items.filter((it) => it.root && !(it.source === 'steam' && it.size) && !this.measured.has(lower(it.root)));
    if (!todo.length || this.measuring) return;
    this.measuring = (async () => {
      let last = 0;
      for (const it of todo) {
        const key = lower(it.root);
        if (this.measured.has(key)) continue;
        this.measured.add(key);
        this.sizes.set(key, await folderSize(it.root));
        if (Date.now() - last > 700) {
          last = Date.now();
          this.send('storage:changed');
        }
      }
      fsp.writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(this.sizes))).catch(() => {});
      this.send('storage:changed');
    })().finally(() => {
      this.measuring = null;
    });
  }

  /**
   * Delete games: Steam ones through one quiet Steam restart, PC ones by
   * deleting their folder (for good) and putting their shortcut in the Recycle
   * Bin so the library forgets them. Returns what went and what didn't.
   */
  async remove(ids) {
    if (this.deleting) throw new Error('Games are being deleted already.');
    const games = this.library.games;
    const guard = this.protectedPaths();
    const running = new Set(this.monitor.list().map((r) => r.id));
    const deleted = [];
    const failed = [];
    const steam = [];
    const pc = [];
    for (const id of ids || []) {
      const g = this.library.find(String(id));
      const at = g && this.locate(g, games, guard);
      if (!g || !at || !at.deletable) failed.push({ id, error: 'It can’t be deleted here.' });
      else if (running.has(g.id)) failed.push({ id, error: 'Close the game first.' });
      else if (g.source === 'steam') steam.push(g);
      else pc.push({ g, root: at.root });
    }
    this.deleting = true;
    this.send('storage:changed');
    try {
      if (steam.length) {
        try {
          const gone = new Set(await this.steam.uninstall(steam.map((g) => g.steamAppId)));
          for (const g of steam) (gone.has(String(g.steamAppId)) ? deleted : failed).push(gone.has(String(g.steamAppId)) ? g.id : { id: g.id, error: 'Steam kept it.' });
        } catch (err) {
          for (const g of steam) failed.push({ id: g.id, error: err.message });
        }
      }
      for (const { g, root } of pc) {
        try {
          await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
          if (fs.existsSync(root)) throw new Error('Some files are in use.');
          if (SHORTCUT.test(g.path || '') && fs.existsSync(g.path)) await shell.trashItem(g.path).catch(() => {});
          if (g.source === 'manual') this.library.forget(g.id);
          this.sizes.delete(lower(root));
          deleted.push(g.id);
        } catch (err) {
          failed.push({ id: g.id, error: err.message });
        }
      }
    } finally {
      this.deleting = false;
    }
    if (deleted.length) await this.library.scan({ silent: true });
    this.send('storage:changed');
    return { deleted, failed };
  }
}

module.exports = { Storage, folderSize };
