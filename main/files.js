// The launcher's own file browser (renderer/js/ui/filebrowser.js) instead of
// Windows' file dialogs and Explorer: folder listings, the places to start
// from (user folders and drives) and file icons.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');

// Windows' own bookkeeping in drive roots and user folders, never what someone is looking for.
const HIDDEN = new Set(['$recycle.bin', 'system volume information', 'desktop.ini', 'thumbs.db', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp', 'config.msi', 'recovery', 'documents and settings', '$windows.~bt', '$windows.~ws', '$winreagent', 'msocache', 'ntuser.dat', 'ntuser.ini']);
const MAX_ENTRIES = 3000;

/**
 * A folder's contents: folders first, then files (only those with one of
 * `exts`, when given). Each with its size and change time.
 */
async function list(dir, { exts = null, files = true } = {}) {
  dir = path.resolve(String(dir || ''));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const denied = err && (err.code === 'EPERM' || err.code === 'EACCES');
    throw new Error(denied ? 'This folder can’t be opened.' : 'This folder isn’t there any more.');
  }
  const want = exts && exts.length ? new Set(exts.map((e) => `.${String(e).replace(/^\./, '').toLowerCase()}`)) : null;
  const picked = [];
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (HIDDEN.has(lower) || lower.startsWith('ntuser.dat') || lower.startsWith('~$')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      // Junctions and links: shown as what they point to, when that can be reached.
      try {
        isDir = (await fsp.stat(path.join(dir, e.name))).isDirectory();
      } catch {
        continue;
      }
    } else if (!isDir && !e.isFile()) continue;
    if (!isDir && (!files || (want && !want.has(path.extname(lower))))) continue;
    picked.push({ name: e.name, dir: isDir });
  }
  const truncated = picked.length > MAX_ENTRIES;
  const shown = picked.slice(0, MAX_ENTRIES);
  for (let i = 0; i < shown.length; i += 64) {
    await Promise.all(
      shown.slice(i, i + 64).map(async (it) => {
        try {
          const st = await fsp.stat(path.join(dir, it.name));
          it.mtime = st.mtimeMs;
          if (!it.dir) it.size = st.size;
        } catch {}
      })
    );
  }
  shown.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? null : parent, entries: shown, truncated };
}

/** Where to start: the user's folders, then every drive. */
async function places(drives) {
  const user = [
    ['desktop', 'Desktop', 'display'],
    ['downloads', 'Downloads', 'download'],
    ['documents', 'Documents', 'file'],
    ['pictures', 'Pictures', 'image'],
    ['videos', 'Videos', 'camera'],
    ['music', 'Music', 'music'],
  ]
    .map(([key, label, icon]) => {
      try {
        return { path: app.getPath(key), label, icon, kind: 'folder' };
      } catch {
        return null;
      }
    })
    .filter((p) => p && fs.existsSync(p.path));
  const drv = (drives || []).map((d) => ({ path: d.root, label: d.label ? `${d.label.trim()} (${d.letter})` : d.letter, icon: 'storage', kind: 'drive', free: d.free, total: d.total }));
  return [...user, ...drv];
}

const iconCache = new Map();
/** A file's own icon (programs, shortcuts) as a data URL. */
async function iconOf(file) {
  const key = String(file || '').toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  let url = null;
  try {
    const img = await app.getFileIcon(file, { size: 'normal' });
    if (!img.isEmpty()) url = img.toDataURL();
  } catch {}
  if (iconCache.size > 500) iconCache.clear();
  iconCache.set(key, url);
  return url;
}

/** A new folder inside `dir`. */
async function mkdir(dir, name) {
  const clean = String(name || '').trim();
  if (!clean || /[<>:"/\\|?*]/.test(clean) || /^\.+$/.test(clean)) throw new Error('That name can’t be used for a folder.');
  const full = path.join(path.resolve(String(dir)), clean);
  await fsp.mkdir(full);
  return full;
}

/** What a path is, if it is there. */
async function kind(p) {
  try {
    const st = await fsp.stat(path.resolve(String(p || '')));
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

module.exports = { list, places, iconOf, mkdir, kind };
