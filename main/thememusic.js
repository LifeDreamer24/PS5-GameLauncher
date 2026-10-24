// Game theme music (as on the PS5: a selected game's music plays behind its
// hub). It is found on YouTube with yt-dlp (main/ytdlp.js, optional): a
// search for "<game> theme music", the best fitting video's audio downloaded
// once into the data folder (thememusic\, the least recently played go past
// 1 GB). A game can also have a chosen video, a file of the player's own,
// or none. Which video a game uses is remembered in thememusic.json.
// fetchAll() does this ahead of time for every installed game.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { JsonStore } = require('./store');

const MATCHING = 3; // raise when the matching improves: remembered results are looked up again
const FOUND_FOR = 60 * 24 * 60 * 60 * 1000; // look again after 60 days
const NONE_FOR = 14 * 24 * 60 * 60 * 1000; // nothing fitting: try again after 14 days
const CACHE_MAX = 1024 * 1024 * 1024;
const AUDIO_FILES = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;
const MAX_FILE = 40 * 1024 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Video titles: what a game's theme is called, and what isn't one.
const THEME = [
  [/\b(main theme|main menu|menu theme|menu music|title theme|title screen|theme song)\b/, 4],
  [/\btheme\b/, 2],
  [/\bmenu\b/, 2],
  [/\b(ost|soundtrack|score|music from the (video )?game)\b/, 2],
  [/\bofficial\b/, 1],
  [/\bmusic\b/, 1],
];
const NOT_THEME = /\b(\d+ ?hours?|1 ?hr|\d+ ?min(ute)?s?|extended|reaction|review|gameplay|walkthrough|playthrough|trailer|teaser|piano|guitar|violin|ocarina|kalimba|music box|cover|covers|performance|concert|remix|lofi|lo fi|8 ?bit|nightcore|slowed|reverb|tutorial|speedrun|live|ringtone|meme|parody|full album|all songs|every song|compilation)\b/;

/** Lower case, no accents or symbols: "Tom Clancy’s Siege™" → "tom clancy s siege". */
function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Edition labels the music doesn't carry ("Horizon Zero Dawn Remastered").
const EDITION = /[\s:–-]*\b(remastered|remaster|remake|deluxe( edition)?|definitive edition|complete edition|ultimate edition|enhanced edition|special edition|anniversary edition|game of the year( edition)?|goty( edition)?|director'?s cut|hd)\s*$/i;
const ROMAN = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii', 8: 'viii', 9: 'ix', 10: 'x' };

/** The game's name without demo/beta and edition labels or trademark signs. */
function cleanName(name) {
  let s = String(name || '')
    .replace(/[™®©]/g, '')
    .replace(/\s*[-–:]\s*(open |closed )?(beta|demo|playtest|prologue|early access)\b.*$/i, '')
    .replace(/\s+(open |closed )?(beta|demo|playtest)$/i, '')
    .trim();
  for (let i = 0; i < 3 && EDITION.test(s); i++) s = s.replace(EDITION, '').trim();
  return s;
}

/**
 * Whether a video title is about this game: most of its name's words are in
 * it (numbers as digits or roman numerals), or its initials ("GTA 5").
 */
function namesGame(title, name) {
  const words = new Set(norm(title).split(' '));
  const has = (w) => words.has(w) || (ROMAN[w] && words.has(ROMAN[w])) || Object.keys(ROMAN).some((k) => ROMAN[k] === w && words.has(k));
  const nameWords = norm(name).split(' ').filter((w) => w.length > 1 || /\d/.test(w));
  if (!nameWords.length) return false;
  const found = nameWords.filter(has).length;
  if (found === nameWords.length || (nameWords.length >= 3 && found / nameWords.length >= 0.75)) return true;
  // Initials of the words before a number: "grand theft auto 5" → "gta" and "5".
  const letters = nameWords.filter((w) => !/^\d+$/.test(w) && !Object.values(ROMAN).includes(w));
  const digits = nameWords.filter((w) => /^\d+$/.test(w) || Object.values(ROMAN).includes(w));
  return letters.length >= 2 && words.has(letters.map((w) => w[0]).join('')) && digits.every(has);
}

/** The name, and how videos may shorten it: without a franchise owner ("Tom Clancy's …") or a subtitle. */
function aliases(name) {
  const out = [name];
  const owner = /^[A-Z][\w.]*(\s[A-Z][\w.]*)?['’]s\s+(.+)$/.exec(name);
  if (owner && norm(owner[2]).split(' ').length >= 2) out.push(owner[2]);
  const short = name.split(/\s*[:–]\s*|\s+-\s+/)[0].trim();
  if (short !== name && norm(short).split(' ').length >= 2) out.push(short);
  return out;
}

/** How well a search result fits as the game's theme: a score, or -1. */
function videoScore(v, name, rank) {
  const t = norm(v.title);
  if (!aliases(name).some((n) => namesGame(v.title, n)) || NOT_THEME.test(t)) return -1;
  if (v.duration && (v.duration < 40 || v.duration > 900)) return -1;
  let score = THEME.reduce((s, [re, w]) => s + (re.test(t) ? w : 0), 0);
  if (score < 2) return -1; // not called a theme, soundtrack or music at all
  if (v.duration && v.duration > 420) score -= 1; // long medleys loop less well
  return score - rank * 0.3;
}

const toTrack = (v) => ({ key: `yt:${v.id}`, source: 'youtube', id: v.id, title: v.title, channel: v.channel || v.uploader || '', duration: v.duration || 0 });

class ThemeMusic {
  constructor({ dataDir, ytdlp, send }) {
    this.ytdlp = ytdlp;
    this.send = send;
    this.cacheDir = path.join(dataDir, 'thememusic');
    this.store = new JsonStore(path.join(dataDir, 'thememusic.json'), { games: {} });
    this.finding = new Map();
    this.downloads = new Map();
    this.previewing = null; // the last tried-out video's download, stopped when another is tried
    this.fetch = { running: false, done: 0, total: 0, found: 0, current: null, stopping: false };
  }

  /**
   * Find and download the theme of every game given (Settings › Sound › Get
   * Theme Music for All Games), two at a time. Games set to off or to a file
   * of their own are skipped. Progress goes out as 'theme:fetch'.
   */
  async fetchAll(games) {
    if (this.fetch.running || !this.ytdlp.installed()) return this.fetch;
    const todo = games.filter((g) => !(g.themeMusic && (g.themeMusic.mode === 'off' || g.themeMusic.mode === 'file')));
    const f = (this.fetch = { running: true, done: 0, total: todo.length, found: 0, current: null, stopping: false });
    const emit = () => this.send('theme:fetch', { ...f });
    emit();
    let next = 0;
    const worker = async () => {
      while (!f.stopping && next < todo.length) {
        const g = todo[next++];
        f.current = g.name;
        emit();
        try {
          const tr = await this.find(g);
          if (tr && tr.source === 'youtube' && !f.stopping) {
            await this.download(tr.id);
            f.found++;
          }
        } catch {}
        f.done++;
        emit();
      }
    };
    await Promise.all([worker(), worker()]);
    f.running = false;
    f.current = null;
    emit();
    return { ...f };
  }

  /** Games that just appeared installed: their themes, quietly, one after another. */
  fetchNew(games) {
    this.newQueue = (this.newQueue || Promise.resolve()).then(async () => {
      for (const g of games) {
        try {
          const tr = await this.find(g);
          if (tr && tr.source === 'youtube') await this.download(tr.id);
        } catch {}
      }
    });
    return this.newQueue;
  }

  stopFetch() {
    if (!this.fetch.running) return;
    this.fetch.stopping = true;
    for (const d of this.downloads.values()) d.ctl.abort();
  }

  /** What plays for a game: { key, source, title, … } or null. */
  async find(game) {
    if (!game) return null;
    const pick = game.themeMusic;
    if (pick && pick.mode === 'off') return null;
    if (pick && pick.mode === 'file' && pick.path) return { key: `file:${pick.path}`, source: 'file', title: path.basename(pick.path).replace(/\.[^.]+$/, ''), path: pick.path };
    if (!this.ytdlp.installed()) return null;
    if (pick && pick.mode === 'track' && pick.id) return { key: `yt:${pick.id}`, ...pick, source: 'youtube' };
    return this.auto(game);
  }

  /** The automatically found video (remembered per game). */
  async auto(game) {
    const cached = this.store.data.games[game.id];
    if (cached && cached.name === game.name && cached.v === MATCHING && Date.now() - cached.at < (cached.none ? NONE_FOR : FOUND_FOR)) {
      return cached.none ? null : toTrack(cached);
    }
    if (this.finding.has(game.id)) return this.finding.get(game.id);
    const job = this.search(game.name)
      .then((v) => {
        this.store.data.games[game.id] = v ? { name: game.name, at: Date.now(), v: MATCHING, id: v.id, title: v.title, channel: v.channel, duration: v.duration } : { name: game.name, at: Date.now(), v: MATCHING, none: true };
        this.store.saveSoon();
        return v ? toTrack(v) : null;
      })
      // Offline or yt-dlp failed: nothing now, and nothing remembered.
      .catch(() => null)
      .finally(() => this.finding.delete(game.id));
    this.finding.set(game.id, job);
    return job;
  }

  async results(query, count) {
    const out = await this.ytdlp.run(['--flat-playlist', '-J', `ytsearch${count}:${query}`], { timeout: 45000 });
    const j = JSON.parse(out);
    return (j.entries || []).filter((v) => v && VIDEO_ID.test(v.id || '')).map((v) => ({ id: v.id, title: v.title || '', channel: v.channel || v.uploader || '', duration: Math.round(v.duration || 0) }));
  }

  /** The best fitting video for a game's name, or null. */
  async search(name) {
    const clean = cleanName(name);
    const list = await this.results(`${clean} theme music`, 10);
    const best = list
      .map((v, i) => ({ v, score: videoScore(v, clean, i) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)[0];
    return best ? best.v : null;
  }

  /** Videos to choose from (Options › Theme Music). */
  async candidates(term, isGame) {
    const q = isGame ? `${cleanName(term)} theme music` : term;
    return (await this.results(q, 15)).filter((v) => !v.duration || v.duration <= 900).map(toTrack);
  }

  /** The audio of a track (from find() or candidates()), as bytes. preview: one tried out in the picker. */
  async audio(track, { preview = false } = {}) {
    if (!track) return null;
    if (track.source === 'file') {
      if (!AUDIO_FILES.test(track.path || '')) throw new Error('This file type can’t be played.');
      const st = await fsp.stat(track.path);
      if (!st.isFile() || st.size > MAX_FILE) throw new Error('This file can’t be used as theme music.');
      return fsp.readFile(track.path);
    }
    if (!VIDEO_ID.test(track.id || '')) return null;
    const file = await this.download(track.id, preview);
    if (!file) return null;
    const now = new Date();
    fsp.utimes(file, now, now).catch(() => {}); // recently played: kept longest
    return fsp.readFile(file);
  }

  async cached(id) {
    const names = await fsp.readdir(this.cacheDir).catch(() => []);
    const name = names.find((n) => n.startsWith(id + '.') && !n.endsWith('.part') && AUDIO_FILES.test(n));
    return name ? path.join(this.cacheDir, name) : null;
  }

  /** The video's audio in the cache (downloaded first if needed): its path. */
  download(id, preview) {
    if (this.downloads.has(id)) return this.downloads.get(id).job;
    // Trying out another video in the picker: the previous try's download stops.
    if (preview && this.previewing && this.previewing.id !== id) this.previewing.ctl.abort();
    const ctl = new AbortController();
    const job = (async () => {
      const have = await this.cached(id);
      if (have) return have;
      await fsp.mkdir(this.cacheDir, { recursive: true });
      const out = await this.ytdlp.run(
        ['-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '--max-filesize', '40M', '-o', path.join(this.cacheDir, '%(id)s.%(ext)s'), '--print', 'after_move:filepath', `https://www.youtube.com/watch?v=${id}`],
        { timeout: 120000, signal: ctl.signal }
      );
      const file = out.trim().split(/\r?\n/).pop();
      this.trim().catch(() => {});
      return file && fs.existsSync(file) ? file : this.cached(id);
    })().finally(() => {
      this.downloads.delete(id);
      if (this.previewing && this.previewing.id === id) this.previewing = null;
    });
    this.downloads.set(id, { job, ctl });
    if (preview) this.previewing = { id, ctl };
    return job;
  }

  /** Keep the cache under its size: the least recently played go first. */
  async trim() {
    const names = await fsp.readdir(this.cacheDir).catch(() => []);
    const files = [];
    for (const n of names) {
      const p = path.join(this.cacheDir, n);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.isFile()) files.push({ p, size: st.size, at: st.mtimeMs, part: n.endsWith('.part') });
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      // Stale partial downloads (stopped or failed) go regardless.
      if (!(total > CACHE_MAX || (f.part && Date.now() - f.at > 60 * 60 * 1000))) continue;
      await fsp.rm(f.p, { force: true }).catch(() => {});
      total -= f.size;
    }
  }

  async cacheSize() {
    const names = await fsp.readdir(this.cacheDir).catch(() => []);
    let total = 0;
    for (const n of names) total += (await fsp.stat(path.join(this.cacheDir, n)).catch(() => ({ size: 0 }))).size;
    return total;
  }

  async clearCache() {
    await fsp.rm(this.cacheDir, { recursive: true, force: true });
  }

  /** A game's choice changed or it was renamed: find its music again. */
  forget(gameId) {
    if (this.store.data.games[gameId]) {
      delete this.store.data.games[gameId];
      this.store.saveSoon();
    }
  }
}

/** A choice from the renderer, kept to what find() understands. */
function sanitizeChoice(c) {
  if (!c || c.mode === 'auto') return null;
  if (c.mode === 'off') return { mode: 'off' };
  if (c.mode === 'file' && typeof c.path === 'string' && AUDIO_FILES.test(c.path)) return { mode: 'file', path: c.path };
  if (c.mode === 'track' && VIDEO_ID.test(String(c.id))) {
    const str = (v) => (typeof v === 'string' ? v.slice(0, 300) : undefined);
    return { mode: 'track', source: 'youtube', id: String(c.id), title: str(c.title), channel: str(c.channel) };
  }
  return null;
}

module.exports = { ThemeMusic, sanitizeChoice, AUDIO_FILES };
