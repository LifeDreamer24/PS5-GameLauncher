// Sound themes: Steam Deck "Audio Loader" packs from deckthemes.com (or a
// local .zip / folder). A pack is a folder with a pack.json and sound files
// named after the Steam Deck UI sounds (deck_ui_navigation.wav, …); music
// packs carry a menu_music.mp3. Installed packs live in <userData>/soundpacks,
// one folder per pack, and are served to the UI as app://sounds/<id>/<file>.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { net } = require('electron');

const API = 'https://api.deckthemes.com';
const SOUND_EXT = /\.(wav|mp3|ogg|m4a|flac)$/i;

/** Minimal ZIP reader (stored and deflated entries), enough for theme packs. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: 256 * 1024 * 1024 });
    else continue;
    files.push({ name, data });
  }
  return files;
}

/** Keep a path inside its folder (no "..", no drive letters). */
function safeRel(name) {
  const parts = String(name)
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..' && !/[:<>|?*"]/.test(s));
  return parts.join(path.sep);
}

class SoundPacks {
  constructor(dir) {
    this.dir = dir;
  }

  async list() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pack = await this.read(e.name);
      if (pack) out.push(pack);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(id) {
    const root = path.join(this.dir, id);
    let meta = {};
    try {
      meta = JSON.parse((await fsp.readFile(path.join(root, 'pack.json'), 'utf8')).replace(/^﻿/, ''));
    } catch {}
    let files = [];
    try {
      files = (await fsp.readdir(root)).filter((f) => SOUND_EXT.test(f));
    } catch {
      return null;
    }
    if (!files.length) return null;
    return {
      id,
      name: String(meta.name || id).replace(/_/g, ' '),
      author: meta.author ? String(meta.author) : '',
      version: meta.version ? String(meta.version) : '',
      music: !!meta.music || files.some((f) => /^menu_music\./i.test(f)),
      ignore: Array.isArray(meta.ignore) ? meta.ignore.map(String) : [],
      mappings: meta.mappings && typeof meta.mappings === 'object' ? meta.mappings : {},
      files,
    };
  }

  /** Write extracted files into <dir>/<id>, flattening to the folder that holds pack.json. */
  async installFiles(id, files) {
    const withPack = files.find((f) => /(^|\/)pack\.json$/i.test(f.name));
    const base = withPack ? withPack.name.replace(/pack\.json$/i, '') : '';
    const keep = files.filter((f) => f.name.startsWith(base) && (SOUND_EXT.test(f.name) || /pack\.json$|copyright|license/i.test(f.name)));
    if (!keep.some((f) => SOUND_EXT.test(f.name))) throw new Error('This pack has no sound files.');
    const root = path.join(this.dir, id);
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
    for (const f of keep) {
      const rel = safeRel(f.name.slice(base.length));
      if (!rel || rel.includes(path.sep)) continue; // packs are flat
      await fsp.writeFile(path.join(root, rel), f.data);
    }
    return this.read(id);
  }

  /** Install a pack from deckthemes.com. */
  async download(theme) {
    if (!theme || !/^[\w-]+$/.test(String(theme.id)) || !/^[\w-]+$/.test(String(theme.downloadId))) throw new Error('Unknown theme');
    const res = await net.fetch(`${API}/blobs/${theme.downloadId}`);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    return this.installFiles(String(theme.id), unzip(buf));
  }

  /** Install from a local .zip or a folder that contains a pack. */
  async installLocal(source) {
    const st = await fsp.stat(source);
    const id = `local-${path.basename(source, path.extname(source)).replace(/[^\w-]+/g, '_').slice(0, 40)}`;
    if (st.isDirectory()) {
      const files = [];
      const walk = async (dir, rel, depth) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory() && depth < 3) await walk(path.join(dir, e.name), r, depth + 1);
          else if (e.isFile()) files.push({ name: r, data: await fsp.readFile(path.join(dir, e.name)) });
        }
      };
      await walk(source, '', 0);
      return this.installFiles(id, files);
    }
    return this.installFiles(id, unzip(await fsp.readFile(source)));
  }

  async remove(id) {
    if (!/^[\w-]+$/.test(String(id))) return;
    await fsp.rm(path.join(this.dir, id), { recursive: true, force: true });
  }

  /** Browse deckthemes.com. kind: 'Audio' (UI sounds) or 'Music'. */
  async browse({ page = 1, search = '', order = 'Most Downloaded', kind = 'Audio' } = {}) {
    const q = new URLSearchParams({ page: String(page), perPage: '24', filters: kind === 'Music' ? 'AUDIO.Music' : 'AUDIO.Audio', order });
    if (search) q.set('search', search);
    const res = await net.fetch(`${API}/themes?${q}`);
    if (!res.ok) throw new Error(`deckthemes.com answered ${res.status}`);
    const j = await res.json();
    return {
      total: j.total || 0,
      items: (j.items || []).map((t) => ({
        id: t.id,
        name: String(t.displayName || t.name || '').replace(/_/g, ' '),
        author: t.specifiedAuthor || (t.author && t.author.username) || '',
        version: t.version || '',
        image: t.images && t.images[0] ? `${API}/blobs/${t.images[0].id}` : null,
        downloadId: t.download ? t.download.id : null,
        downloads: t.download ? t.download.downloadCount || 0 : 0,
        stars: t.starCount || 0,
        music: (t.targets || []).includes('Music') || t.target === 'Music',
      })),
    };
  }
}

module.exports = { SoundPacks, unzip };
