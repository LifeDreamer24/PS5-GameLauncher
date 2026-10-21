// Steam downloads: which Steam games need an update and how their downloads
// are going, for the game hub ("Update"), the quick menu and the Downloads
// screen. Everything is read from Steam's own files; nothing talks to Steam
// except starting an update, which goes through steam.exe like a steam:// link
// (no Steam window).
//
//  - steamapps\appmanifest_<appid>.acf (every library): StateFlags (update
//    required / running / paused…), BytesToDownload / BytesDownloaded,
//    BytesToStage / BytesStaged, UpdateResult (why it stopped).
//  - logs\content_log.txt: state changes as they happen (queued, downloading,
//    committing…) and the current download rate, logged about once a minute.
//
// Starting an update: Steam has no link for "update now" (its own button calls
// an internal function), and steam://install does nothing for a game that is
// installed. Two ways do it:
//  - The game's manifest says its update already started (StateFlags "update
//    started"), and Steam (which reads manifests only when it starts) starts:
//    it takes the update up at once, with no check of the game's files.
//    A running Steam is restarted in the tray for it (~10 s, tested 2026-10-21).
//  - steam://validate: Steam checks all the installed files first (minutes for
//    a 30+ GB game), puts the game first in its queue and downloads the update.
// The first is used for games of QUICK_UPDATE_MIN and more, or when Steam
// isn't running anyway; validate for small games (a quick check beats a
// restart) and while a game runs (closing Steam would close it). Steam only
// takes links once it is signed in, so when it isn't running it is started in
// the tray first.
//
// Installing a game the user owns (library entries with installed: false):
// steam://install alone opens Steam's install dialog (which drive…). The
// launcher asks that itself instead: it writes the game's appmanifest into
// the chosen library (StateFlags 1026, "needs an update"), and Steam, which
// reads manifests only when it starts, is restarted in the tray. Then
// steam://install just starts the download. Without a chosen library the
// dialog route is still there (brought in front of the launcher).
//
// Both are watched (fs.watch) and polled slowly as a fallback. Neither is
// live, though: Steam writes the manifest's byte counts only when an update
// stops or pauses, and logs its download rate once a minute. So while a
// download runs, progress comes from steam.exe's I/O counters (read by the
// helper from the system process list, about once a second): its network
// traffic ("other" I/O) is the download, its disk writes are the update being
// staged. They are added to the exact numbers Steam logs when the download
// starts or resumes ("update started : download X/Y … stage A/B").

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const { parseVdf, getCI } = require('./vdf');
const scanner = require('./scanner');
const { appDetails, steamAccounts } = require('./steamowned');

// A game this big (on disk) is updated by restarting Steam, not by validating it.
const QUICK_UPDATE_MIN = 5 * 1024 ** 3;

// EAppState bits used in StateFlags.
const S = {
  updateRequired: 2,
  installed: 4,
  filesMissing: 32,
  running: 64,
  updateRunning: 256,
  updatePaused: 512,
  updateStarted: 1024,
};

// EAppUpdateError (UpdateResult), the ones worth a sentence.
const UPDATE_ERRORS = {
  5: 'You no longer own this game.',
  6: 'No connection to Steam.',
  7: 'Steam timed out.',
  10: 'Steam couldn’t read from the disk.',
  11: 'Steam couldn’t write to the disk.',
  12: 'Not enough disk space.',
  13: 'Some game files are corrupt.',
  15: 'The install folder isn’t valid.',
  16: 'The game is running.',
  21: 'No download servers are available.',
  27: 'Steam’s download cache is corrupt.',
  31: 'The update files are corrupt.',
  32: 'Downloads are turned off in Steam.',
  36: 'The download was corrupt.',
  37: 'The disk reported an error.',
  38: 'Steam isn’t allowed to write to the game folder.',
  39: 'A game file is in use.',
  43: 'Not enough disk space.',
};
// Results that are just Steam pausing or rescheduling, not failures.
const NOT_ERRORS = new Set([0, 2, 3, 4, 19]);

const LOG_TAIL = 1024 * 1024; // read at most this much of the log at a time
const SLOW_POLL = 20000;
const FAST_POLL = 2000; // manifests, while something downloads
const PUBLISH_MS = 1000;
const START_TIMEOUT = 30000; // Steam should react to an update request within this

function localTime(s) {
  // "2026-10-09 00:05:45", local time.
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.now();
}

const labels = (s) =>
  new Set(
    String(s || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x && x !== 'None')
  );

class SteamDownloads {
  /**
   * @param {object} o
   * @param {import('./library').Library} o.library
   * @param {{ request(cmd: string, args?: object, timeout?: number): Promise<any>, available(): boolean }} o.system
   * @param {{ procNames?: Map<string, number[]>, list(): any[] }} o.monitor
   * @param {{ data: object }} o.settings
   * @param {(channel: string, payload: any) => void} o.send
   * @param {{ cover?(on: boolean): void, focus?(): void, installed?(appid: string): void }} [o.hooks]
   *   cover: the launcher stays in front while Steam is asked; focus: back to the launcher;
   *   installed: a game finished installing (the library looks again)
   */
  constructor({ library, system, monitor, settings, send, hooks = {} }) {
    this.hooks = hooks;
    this.library = library;
    this.system = system;
    this.monitor = monitor;
    this.settings = settings;
    this.send = send;
    this.steamPath = null;
    this.libs = [];
    this.apps = new Map(); // appid -> manifest data
    this.logs = new Map(); // appid -> what the content log says
    this.rate = null; // { bps, at } last "Current download rate"
    this.speed = new Map(); // appid -> { samples: [{ t, bytes }], bps, shown }
    this.requests = new Map(); // appid -> time the launcher asked Steam to update it
    this.waitingSteam = new Set(); // appids whose request waits for Steam to start and sign in
    this.installs = new Map(); // appid -> { at, name, gameId }: install asked for, no manifest yet
    this.autoAsked = new Map(); // appid -> target build already asked for automatically
    this.notified = new Map(); // appid -> last status announced
    this.watchers = [];
    this.logFile = null;
    // Live progress from steam.exe's I/O counters (see the top of this file).
    this.io = null; // last sample { t, pid, other, write }
    this.ioSamples = [];
    this.ioSpeed = 0; // bytes/s over the last few seconds
    this.live = new Map(); // appid -> { done, staged, other, write, pid }: exact counts and the counters at that moment
    this.anchorDue = new Set(); // appids whose "update started" line still needs its counters
    this.firstRead = true;
    this.logPos = 0;
    this.timer = null;
    this.publishTimer = null;
    this.lastSig = '';
    this.lastSent = 0;
  }

  async start() {
    this.steamPath = await scanner.findSteamPath();
    if (!this.steamPath) return;
    this.logFile = path.join(this.steamPath, 'logs', 'content_log.txt');
    await this.findLibraries();
    await this.readAllManifests();
    await this.readLog(true);
    this.watch();
    this.schedule();
    this.publish(true);
  }

  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.publishTimer);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }

  /* ---------------------------------------------------------------- */
  /* Reading Steam's files                                             */
  /* ---------------------------------------------------------------- */

  async findLibraries() {
    // One entry per folder (Windows paths ignore case); libraryfolders.vdf has the nicer spelling.
    const libs = new Map([[path.normalize(this.steamPath).toLowerCase(), path.normalize(this.steamPath)]]);
    try {
      const text = await fsp.readFile(path.join(this.steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      const root = getCI(parseVdf(text), 'libraryfolders') || {};
      for (const v of Object.values(root)) {
        const p = v && typeof v === 'object' ? getCI(v, 'path') : typeof v === 'string' && /[\\/]/.test(v) ? v : null;
        if (p) libs.set(path.normalize(p).toLowerCase(), path.normalize(p));
      }
    } catch {}
    this.libs = [...libs.values()].map((l) => path.join(l, 'steamapps')).filter((d) => fs.existsSync(d));
  }

  async readAllManifests() {
    const seen = new Set();
    for (const dir of this.libs) {
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^appmanifest_(\d+)\.acf$/i.exec(f);
        if (!m) continue;
        seen.add(m[1]);
        await this.readManifest(path.join(dir, f));
      }
    }
    for (const id of [...this.apps.keys()]) if (!seen.has(id)) this.apps.delete(id); // uninstalled
  }

  /** Re-read only the manifests that changed on disk. */
  async refreshManifests() {
    for (const a of [...this.apps.values()]) {
      try {
        const st = await fsp.stat(a.file);
        if (st.mtimeMs !== a.mtime || st.size !== a.size) await this.readManifest(a.file);
      } catch {
        this.apps.delete(a.appid);
      }
    }
  }

  async readManifest(file) {
    let text;
    let st;
    try {
      st = await fsp.stat(file);
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }
    let s;
    try {
      s = getCI(parseVdf(text), 'AppState');
    } catch {
      return;
    }
    if (!s) return; // written half-way; the next change reads it again
    const appid = String(getCI(s, 'appid') || '');
    if (!appid) return;
    const n = (k) => Number(getCI(s, k) || 0);
    const a = {
      appid,
      file,
      mtime: st.mtimeMs,
      size: st.size,
      name: scanner.tidyName(getCI(s, 'name') || ''),
      flags: n('StateFlags'),
      toDownload: n('BytesToDownload'),
      downloaded: n('BytesDownloaded'),
      toStage: n('BytesToStage'),
      staged: n('BytesStaged'),
      result: n('UpdateResult'),
      onDisk: n('SizeOnDisk'),
      scheduled: n('ScheduledAutoUpdate') * 1000,
      buildId: String(getCI(s, 'buildid') || ''),
      targetBuild: String(getCI(s, 'TargetBuildID') || ''),
    };
    this.apps.set(appid, a);
    this.sample(appid, a.downloaded);
  }

  /** Read what was added to content_log.txt since last time (or its recent end, at first). */
  async readLog(first = false) {
    if (!this.logFile) return;
    let fh;
    try {
      fh = await fsp.open(this.logFile, 'r');
      const { size } = await fh.stat();
      if (size < this.logPos) this.logPos = 0; // Steam started a new log
      let from = first ? Math.max(0, size - LOG_TAIL) : this.logPos;
      if (size - from > LOG_TAIL) from = size - LOG_TAIL;
      if (size <= from) {
        this.logPos = size;
        return;
      }
      const buf = Buffer.alloc(size - from);
      await fh.read(buf, 0, buf.length, from);
      this.logPos = size;
      let text = buf.toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1); // a partial first line
      for (const line of text.split(/\r?\n/)) this.parseLine(line);
      this.firstRead = false;
    } catch {
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  parseLine(line) {
    const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (.*)$/.exec(line);
    if (!m) return;
    const at = localTime(m[1]);
    const msg = m[2];
    let x;
    if (msg.startsWith('Client version:')) {
      // Steam (re)started: what it said before no longer holds.
      this.logs.clear();
      this.rate = null;
      return;
    }
    if ((x = /^Current download rate: ([\d.]+) Mbps/.exec(msg))) {
      this.rate = { bps: (parseFloat(x[1]) * 1e6) / 8, at };
      return;
    }
    if (!(x = /^AppID (\d+) (.*)$/.exec(msg))) return;
    const appid = x[1];
    const rest = x[2];
    const l = this.logs.get(appid) || { state: new Set(), update: new Set(), at: 0 };
    let y;
    if ((y = /^state changed : ([^(]*)(?:\((.*)\))?/.exec(rest))) {
      l.state = labels(y[1]);
      l.reason = y[2] ? y[2].trim() : '';
      l.at = at;
    } else if ((y = /^App update changed : (.*)$/.exec(rest))) {
      l.update = labels(y[1]);
      // Between steps Steam logs a bare "Running Update": keep showing the last step.
      if (l.update.size > 1 || !l.update.has('Running Update')) l.steps = l.update;
      l.at = at;
    } else if ((y = /^update started : download (\d+)\/(\d+)(?:.*?stage (\d+)\/(\d+))?/.exec(rest))) {
      l.started = { at, done: Number(y[1]), total: Number(y[2]), staged: Number(y[3] || 0), stageTotal: Number(y[4] || 0) };
      this.live.delete(appid);
      if (!this.firstRead) this.anchorDue.add(appid);
    } else if (/^finished update/.test(rest)) {
      l.update = new Set();
      l.steps = null;
      l.finishedAt = at;
    } else if ((y = /^scheduler finished : removed from schedule \(result ([^,]+)/.exec(rest))) {
      l.schedulerResult = y[1].trim();
      l.at = at;
    } else return;
    this.logs.set(appid, l);
  }

  watch() {
    const onChange = () => this.changedSoon();
    for (const dir of this.libs) {
      try {
        const w = fs.watch(dir, { persistent: false }, (_evt, name) => {
          const m = name && /^appmanifest_(\d+)\.acf$/i.exec(name);
          // A manifest Steam just created (a game being installed): read it right away.
          if (m && !this.apps.has(m[1])) this.readManifest(path.join(dir, name)).then(onChange, onChange);
          else if (!name || m || /^libraryfolders\.vdf$/i.test(name)) onChange();
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {}
    }
    try {
      const w = fs.watch(path.dirname(this.logFile), { persistent: false }, (_evt, name) => {
        if (!name || /^content_log\.txt$/i.test(name)) onChange();
      });
      w.on('error', () => {});
      this.watchers.push(w);
    } catch {}
  }

  changedSoon() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.refresh().catch(() => {}), 400);
  }

  schedule() {
    clearTimeout(this.timer);
    const busy = this.items().some((i) => i.status === 'downloading' || i.status === 'installing' || i.status === 'starting');
    this.timer = setTimeout(async () => {
      try {
        if (!busy) {
          // A library added in Steam, a game installed: look at everything again now and then.
          await this.findLibraries();
          await this.readAllManifests();
        }
        await this.refresh();
      } catch {}
      this.schedule();
    }, busy ? FAST_POLL : SLOW_POLL);
  }

  async refresh() {
    await this.refreshManifests();
    await this.readLog();
    if (this.anchorDue.size) {
      await this.sampleIo();
      for (const appid of this.anchorDue) {
        const l = this.logs.get(appid);
        if (l && l.started && this.io) this.live.set(appid, { done: l.started.done, staged: l.started.staged, other: this.io.other, write: this.io.write, pid: this.io.pid });
      }
      this.anchorDue.clear();
    }
    this.checkRequests();
    this.autoUpdate();
    this.announce();
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Speed                                                              */
  /* ---------------------------------------------------------------- */

  sample(appid, bytes) {
    const s = this.speed.get(appid) || { samples: [], bps: 0, shown: 0 };
    const now = Date.now();
    const last = s.samples[s.samples.length - 1];
    if (!last || last.bytes !== bytes) s.samples.push({ t: now, bytes });
    if (last && bytes < last.bytes) s.samples = [{ t: now, bytes }]; // a new download
    const newest = s.samples[s.samples.length - 1];
    s.samples = s.samples.filter((x) => now - x.t < 60000).slice(-30);
    if (!s.samples.length && newest) s.samples = [newest];
    const first = s.samples[0];
    const end = s.samples[s.samples.length - 1];
    if (end && first && end.t - first.t >= 3000) s.bps = (end.bytes - first.bytes) / ((end.t - first.t) / 1000);
    this.speed.set(appid, s);
  }

  /** steam.exe's I/O counters now, and the network speed over the last few seconds. */
  async sampleIo() {
    if (!this.system.available()) return;
    try {
      const list = await this.system.request('procIo', { name: 'steam' }, 3000);
      const p = (list || []).sort((x, y) => y.other - x.other)[0];
      if (!p) return;
      const now = { t: Date.now(), pid: p.pid, other: Number(p.other), write: Number(p.write) };
      if (this.io && this.io.pid !== now.pid) {
        // Steam restarted: its counters started again from zero.
        this.ioSamples = [];
        this.live.clear();
      }
      this.ioSamples = this.ioSamples.filter((x) => now.t - x.t <= 4000);
      this.ioSamples.push(now);
      const first = this.ioSamples[0];
      if (now.t - first.t >= 900) this.ioSpeed = Math.max(0, (now.other - first.other) / ((now.t - first.t) / 1000));
      this.io = now;
    } catch {}
  }

  steamRunning() {
    const names = this.monitor.procNames;
    return names ? names.has('steam') : true; // (names come without .exe) not known yet: trust the files
  }

  /* ---------------------------------------------------------------- */
  /* What is going on                                                  */
  /* ---------------------------------------------------------------- */

  gameFor(appid) {
    const games = this.library.games.filter((g) => String(g.steamAppId) === appid);
    return games.find((g) => g.source === 'steam') || games[0] || null;
  }

  /**
   * Every Steam app with an update to do or under way:
   * status: available | starting | queued | downloading | installing | paused | error
   */
  items() {
    const out = [];
    let liveTaken = false; // the I/O counters go to one game (the first one under way)
    const steamOn = this.steamRunning();
    const now = Date.now();
    for (const a of this.apps.values()) {
      const game = this.gameFor(a.appid);
      if (!game && (scanner.STEAM_EXCLUDED_IDS.has(a.appid) || scanner.STEAM_EXCLUDED_NAMES.test(a.name))) continue;
      const l = this.logs.get(a.appid) || { state: new Set(), update: new Set() };
      const f = a.flags;
      // The log is newer than the manifest while Steam works on it (it writes the manifest less often).
      const logNewer = l.state.size > 0 && l.at >= a.mtime - 2000;
      const flag = (bit, label) => (logNewer ? l.state.has(label) : !!(f & bit));
      const needs = flag(S.updateRequired, 'Update Required');
      const started = flag(S.updateStarted, 'Update Started');
      // Steam's finishing steps after the update is in place don't count.
      const runningUpdate = steamOn && (needs || started) && (l.update.has('Running Update') || (!!(f & S.updateRunning) && !l.update.size));
      const paused = flag(S.updatePaused, 'Update Paused');
      const queued = l.state.has('Update Queued');
      const asked = this.requests.get(a.appid);
      if (!needs && !started && !runningUpdate) continue;
      let status = 'available';
      let phase = '';
      if (runningUpdate) {
        const has = (p) => [...(l.steps || l.update)].some((x) => x.startsWith(p));
        if (has('Committing')) phase = 'committing';
        else if (has('Verifying Installed') || has('Validating')) phase = 'checking'; // steam://validate looks at the game first
        else if (has('Verifying')) phase = 'verifying';
        else if (has('Preallocating') || has('Reconfiguring')) phase = 'preparing';
        else if (has('Staging') && !has('Downloading')) phase = 'staging';
        else phase = 'downloading';
        status = phase === 'downloading' || phase === 'preparing' ? 'downloading' : 'installing';
      } else if (queued && steamOn) status = 'queued';
      else if (asked && (this.waitingSteam.has(a.appid) || now - asked < START_TIMEOUT)) status = 'starting';
      else if (paused || started) status = 'paused';
      const errText = !NOT_ERRORS.has(a.result) && a.result ? UPDATE_ERRORS[a.result] || `Steam error ${a.result}.` : '';
      if (status === 'paused' && errText) status = 'error';
      // Bytes: the manifest, or what the log said when the update started.
      let total = a.toDownload;
      let done = a.downloaded;
      if (!total && l.started) {
        total = l.started.total;
        done = Math.max(done, l.started.done);
      }
      const sp = this.speed.get(a.appid) || { bps: 0, shown: 0 };
      let bps = 0;
      let staged = a.staged;
      const working = status === 'downloading' || status === 'installing';
      if (working && this.io && !this.live.has(a.appid) && !liveTaken) {
        // Under way since before the launcher looked: start from what is known.
        const base = l.started && l.started.done > a.downloaded ? l.started : { done: a.downloaded, staged: a.staged };
        this.live.set(a.appid, { done: base.done, staged: base.staged || a.staged, other: this.io.other, write: this.io.write, pid: this.io.pid });
      }
      if (!working) this.live.delete(a.appid);
      const lv = working && !liveTaken ? this.live.get(a.appid) : null;
      if (lv && this.io && this.io.pid === lv.pid) {
        // Steam downloads one game at a time: its traffic since the anchor is this game's.
        liveTaken = true;
        if (l.started && l.started.total) total = total || l.started.total;
        done = Math.max(done, lv.done + (this.io.other - lv.other));
        staged = Math.max(staged, lv.staged + (this.io.write - lv.write));
        bps = status === 'downloading' ? this.ioSpeed : 0;
        sp.shown = 0;
      } else if (status === 'downloading') {
        const fresh = sp.samples && sp.samples.length > 1 && now - sp.samples[sp.samples.length - 1].t < 15000;
        bps = fresh && sp.bps > 0 ? sp.bps : this.rate && now - this.rate.at < 120000 ? this.rate.bps : sp.bps;
        // Between manifest writes, move on at the measured speed (never backwards, never past the end).
        const last = sp.samples && sp.samples[sp.samples.length - 1];
        if (last && bps > 0) done = Math.max(done, Math.min(total - 1, last.bytes + (bps * (now - last.t)) / 1000));
        done = Math.max(done, sp.shown || 0);
        sp.shown = done;
      } else sp.shown = 0;
      out.push({
        appid: a.appid,
        gameId: game ? game.id : null,
        name: game ? game.name : a.name,
        status,
        phase,
        total,
        done: Math.min(done, total),
        stageTotal: a.toStage || (l.started && l.started.stageTotal) || 0,
        staged: Math.min(staged, a.toStage || (l.started && l.started.stageTotal) || staged),
        speed: Math.round(bps),
        eta: bps > 0 && total > done ? Math.round((total - done) / bps) : null,
        error: status === 'error' ? errText : '',
        scheduled: status === 'available' && a.scheduled > now ? a.scheduled : 0,
        steamRunning: steamOn,
        waitingSteam: status === 'starting' && this.waitingSteam.has(a.appid),
        restartingSteam: status === 'starting' && this.waitingSteam.has(a.appid) && !!this.restartingSteam,
        since: (l.started && l.started.at) || l.at || 0,
      });
    }
    // Installs asked for whose dialog is still open in Steam (no manifest yet).
    for (const [appid, inst] of this.installs) {
      if (this.apps.has(appid)) {
        this.installs.delete(appid);
        continue;
      }
      if (now - inst.at > 3 * 60000) {
        this.installs.delete(appid); // cancelled in Steam
        continue;
      }
      out.push({
        appid,
        gameId: inst.gameId,
        name: inst.name,
        status: 'starting',
        phase: inst.restarting ? 'restarting' : 'confirm',
        install: true,
        total: 0,
        done: 0,
        stageTotal: 0,
        staged: 0,
        speed: 0,
        eta: null,
        error: '',
        scheduled: 0,
        steamRunning: steamOn,
        waitingSteam: this.waitingSteam.has(appid),
        since: inst.at,
      });
    }
    // Under way first, then queued, then the rest; Steam's own order within each.
    const rank = { downloading: 0, installing: 0, starting: 1, queued: 2, paused: 3, error: 4, available: 5 };
    return out.sort((x, y) => rank[x.status] - rank[y.status] || x.since - y.since || x.name.localeCompare(y.name));
  }

  publicState() {
    return { available: !!this.steamPath, steamRunning: this.steamRunning(), items: this.items() };
  }

  publish(now = false) {
    clearTimeout(this.publishTimer);
    const go = async () => {
      if (this.publishing) return;
      this.publishing = true;
      try {
        if (this.items().some((i) => i.status === 'downloading' || i.status === 'installing')) await this.sampleIo();
      } finally {
        this.publishing = false;
      }
      const st = this.publicState();
      const busy = st.items.some((i) => i.status === 'downloading' || i.status === 'installing');
      const sig = JSON.stringify(st.items.map((i) => [i.appid, i.status, i.phase, i.error, i.total, busy ? Math.round(i.done / 1e5) : i.done]));
      if (sig !== this.lastSig) {
        this.lastSig = sig;
        this.lastSent = Date.now();
        this.send('downloads:state', st);
      }
      // Progress moves on between manifest writes.
      if (busy) this.publishTimer = setTimeout(go, PUBLISH_MS);
    };
    if (now) go();
    else this.publishTimer = setTimeout(go, 150);
  }

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */

  announce() {
    const items = this.items();
    const current = new Map(items.map((i) => [i.appid, i]));
    for (const [appid, was] of this.notified) {
      if (current.has(appid)) continue;
      // Gone from the list: done, if it was being updated.
      this.notified.delete(appid);
      const a = this.apps.get(appid);
      if (a && !(a.flags & S.updateRequired) && ['downloading', 'installing', 'queued', 'paused', 'starting'].includes(was)) {
        const game = this.gameFor(appid);
        const fresh = !!game && game.installed === false;
        this.notify({ title: fresh ? 'Download complete' : 'Update complete', body: game ? game.name : a.name, gameId: game && game.id });
        if (fresh && this.hooks.installed) this.hooks.installed(appid);
      }
    }
    for (const i of items) {
      const was = this.notified.get(i.appid);
      if (was === i.status) continue;
      this.notified.set(i.appid, i.status);
      if (was === undefined && i.status === 'available') continue; // seen at startup: the hub says so
      const busy = (x) => x === 'downloading' || x === 'installing';
      if (busy(i.status) && !busy(was)) {
        const game = this.gameFor(i.appid);
        const title = game && game.installed === false ? 'Downloading' : 'Downloading update';
        this.notify({ title, body: i.total ? `${i.name} · ${fmtBytes(i.total)}` : i.name, gameId: i.gameId, silent: was === undefined });
      } else if (i.status === 'error' && was !== undefined) {
        this.notify({ title: `Couldn't update ${i.name}`, body: i.error, icon: 'info', gameId: i.gameId });
      }
    }
  }

  notify(n) {
    this.send('notify', { icon: 'download', kind: 'downloads', ...n });
  }

  /* ---------------------------------------------------------------- */
  /* Starting updates                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Ask Steam to update a game now (it would otherwise wait for its schedule
   * or the next start of the game). Steam starts minimized to the tray if it
   * isn't running.
   */
  async update(appid) {
    appid = String(appid);
    if (!this.steamPath || !/^\d+$/.test(appid)) throw new Error('Steam was not found.');
    this.requests.set(appid, Date.now());
    this.waitingSteam.add(appid);
    this.publish(true);
    this.schedule();
    try {
      if (!(await this.updateByRestart(appid))) {
        await this.ensureSteam();
        await this.quietly(() => this.steamUrl(`steam://validate/${appid}`));
      }
    } catch (err) {
      this.requests.delete(appid);
      throw err;
    } finally {
      this.waitingSteam.delete(appid);
    }
    this.requests.set(appid, Date.now()); // Steam has START_TIMEOUT from now to take it up
    this.publish(true);
    return true;
  }

  /**
   * Start an update without Steam checking the game's files: mark it started
   * in its manifest while Steam is closed, then start Steam in the tray (see
   * the top of this file). One restart at a time. False when validate is the
   * better way (a small game with Steam running, a game running, no manifest).
   */
  updateByRestart(appid) {
    const run = async () => {
      await this.refreshManifests().catch(() => {});
      const a = this.apps.get(appid);
      if (!a || !(a.flags & S.installed) || this.monitor.list().length) return false;
      if ((a.flags & S.updateRunning) !== 0) return true; // already going
      const steamRunning = await this.steamProcess();
      if (steamRunning && a.onDisk < QUICK_UPDATE_MIN) return false;
      this.restartingSteam = steamRunning;
      this.publish(true);
      try {
        await this.stopSteam(); // Steam writes its manifests as it closes: change them after
        const text = await fsp.readFile(a.file, 'utf8');
        const m = /("StateFlags"\s+")(\d+)(")/.exec(text);
        if (!m) return false;
        const flags = Number(m[2]) | S.updateStarted;
        if (flags !== Number(m[2])) await fsp.writeFile(a.file, text.slice(0, m.index) + m[1] + flags + m[3] + text.slice(m.index + m[0].length), 'utf8');
        await this.startSteam();
        await this.readManifest(a.file);
        return true;
      } finally {
        this.restartingSteam = false;
      }
    };
    const next = (this.restartQueue || Promise.resolve()).then(run, run);
    this.restartQueue = next.catch(() => {});
    return next;
  }

  /**
   * Install a game the user owns: Steam's install dialog opens (in front of
   * the launcher); once the user confirms, the download shows up like an update.
   */
  async install(appid, { name = '', gameId = null } = {}) {
    appid = String(appid);
    if (!this.steamPath || !/^\d+$/.test(appid)) throw new Error('Steam was not found.');
    this.installs.set(appid, { at: Date.now(), name, gameId });
    this.waitingSteam.add(appid);
    this.publish(true);
    this.schedule();
    try {
      await this.ensureSteam();
    } catch (err) {
      this.installs.delete(appid);
      throw err;
    } finally {
      this.waitingSteam.delete(appid);
    }
    const main = this.system.available() ? await this.steamWindow() : null;
    const shown = new Set((await this.steamWindows()).filter((w) => w.visible).map((w) => w.hwnd));
    this.installs.set(appid, { at: Date.now(), name, gameId });
    await this.steamUrl(`steam://install/${appid}`);
    this.publish(true);
    this.followDialog(shown, !!(main && main.visible && !main.minimized)).catch(() => {});
    return true;
  }

  /** The Steam libraries (drives) a game can go to, with their free space, and the game's sizes. */
  async installInfo(appid) {
    if (!this.steamPath) throw new Error('Steam was not found.');
    await this.findLibraries();
    const libraries = [];
    for (const dir of this.libs) {
      const root = path.dirname(dir);
      let free = 0;
      let total = 0;
      try {
        const st = await fsp.statfs(root);
        free = Number(st.bavail) * Number(st.bsize);
        total = Number(st.blocks) * Number(st.bsize);
      } catch {}
      if (!libraries.some((l) => l.path.toLowerCase() === root.toLowerCase())) libraries.push({ path: root, drive: root.slice(0, 2).toUpperCase(), free, total });
    }
    const details = await appDetails(this.steamPath, appid).catch(() => null);
    return {
      libraries,
      size: (details && details.size) || 0,
      download: (details && details.download) || 0,
      steamRunning: await this.steamProcess(),
      gameRunning: this.monitor.list().length > 0,
    };
  }

  /**
   * Install into a library the user picked in the launcher, without Steam's
   * dialog: the manifest goes into that library, Steam restarts in the tray
   * (it only reads manifests when it starts) and is told to install.
   */
  async installTo(appid, library, { name = '', gameId = null } = {}) {
    appid = String(appid);
    if (!this.steamPath || !/^\d+$/.test(appid)) throw new Error('Steam was not found.');
    if (this.monitor.list().length) throw new Error('Close the game first: Steam restarts in the background to start the download.');
    await this.findLibraries();
    const lib = this.libs.find((d) => path.dirname(d).toLowerCase() === String(library || '').toLowerCase());
    if (!lib) throw new Error('That Steam library folder is gone.');
    const details = await appDetails(this.steamPath, appid);
    if (!details || !details.installdir) throw new Error('Steam has no install details for this game yet. Open it in Steam once, then try again.');
    const { active } = await steamAccounts(this.steamPath);
    this.requests.set(appid, Date.now());
    this.waitingSteam.add(appid);
    this.installs.set(appid, { at: Date.now(), name: name || details.name, gameId, restarting: true });
    this.publish(true);
    this.schedule();
    try {
      const file = path.join(lib, `appmanifest_${appid}.acf`);
      if (!fs.existsSync(file)) {
        const q = (v) => String(v).replace(/["\\]/g, '');
        const fields = {
          appid,
          universe: 1,
          name: q(details.name || name),
          StateFlags: 1026, // update required + update started: Steam downloads it
          installdir: q(details.installdir),
          LastUpdated: 0,
          SizeOnDisk: 0,
          StagingSize: 0,
          buildid: 0,
          LastOwner: active ? (BigInt(active) + 76561197960265728n).toString() : 0,
          UpdateResult: 0,
          BytesToDownload: 0,
          BytesDownloaded: 0,
          BytesToStage: 0,
          BytesStaged: 0,
          TargetBuildID: 0,
          AutoUpdateBehavior: 0,
          AllowOtherDownloads: 0,
          ScheduledAutoUpdate: 0,
        };
        const body = `"AppState"\n{\n${Object.entries(fields).map(([k, v]) => `\t"${k}"\t\t"${v}"`).join('\n')}\n}\n`;
        await fsp.writeFile(file, body, 'utf8');
      }
      await this.restartSteam();
      this.installs.delete(appid);
      await this.quietly(() => this.steamUrl(`steam://install/${appid}`));
      // Steam asked anyway (it didn't take the manifest): let the user answer it.
      const dialog = (await this.steamWindows()).find((w) => w.title === 'Install');
      if (dialog) await this.system.request('fgSet', { hwnd: dialog.hwnd }, 3000).catch(() => {});
    } catch (err) {
      this.requests.delete(appid);
      this.installs.delete(appid);
      throw err;
    } finally {
      this.waitingSteam.delete(appid);
    }
    this.requests.set(appid, Date.now());
    await this.readAllManifests().catch(() => {});
    this.publish(true);
    return true;
  }

  /** Steam closed (cleanly) and started again in the tray, signed in. */
  async restartSteam() {
    this.restartingSteam = true;
    this.publish(true);
    try {
      await this.restartSteamNow();
    } finally {
      this.restartingSteam = false;
    }
  }

  async restartSteamNow() {
    await this.stopSteam();
    await this.startSteam();
  }

  /** Steam closed cleanly (if it was running). */
  async stopSteam() {
    if (!(await this.steamProcess())) return;
    await this.steamUrl('-shutdown');
    let closed = false;
    for (let i = 0; i < 60 && !closed; i++) {
      await new Promise((r) => setTimeout(r, 500));
      closed = !(await this.steamProcess());
    }
    if (!closed) throw new Error('Steam didn’t close. Close Steam, then try again.');
  }

  /** Steam started in the tray and signed in. */
  async startSteam() {
    const since = Date.now() - 2000;
    await this.steamUrl('-silent');
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.signedInSince(since)) {
        await new Promise((r) => setTimeout(r, 3000)); // its library and downloads come up right after
        return;
      }
    }
    throw new Error('Steam didn’t sign in. Open Steam and sign in, then try again.');
  }

  /**
   * Uninstall games without Steam's dialog: Steam closes (it keeps its list of
   * installed games in memory and would write a manifest back), each game's
   * manifest and folders go (its files in steamapps\common, downloads, shader
   * cache and workshop items, as Steam's own uninstall does), and Steam starts
   * again in the tray if it was running. Cloud saves and userdata stay.
   */
  async uninstall(appids) {
    if (!this.steamPath) throw new Error('Steam was not found.');
    appids = [...new Set((appids || []).map(String))].filter((a) => /^\d+$/.test(a));
    if (!appids.length) return [];
    if (this.monitor.list().length) throw new Error('Close the game first: Steam restarts in the background to remove games.');
    await this.findLibraries();
    const targets = [];
    for (const appid of appids) {
      const busy = this.items().find((it) => it.appid === appid && ['starting', 'queued', 'downloading', 'installing'].includes(it.status));
      if (busy) throw new Error('Stop its download in Steam first.');
      for (const lib of this.libs) {
        const manifest = path.join(lib, `appmanifest_${appid}.acf`);
        if (!fs.existsSync(manifest)) continue;
        let installdir = '';
        try {
          installdir = String(getCI(getCI(parseVdf(await fsp.readFile(manifest, 'utf8')), 'AppState') || {}, 'installdir') || '');
        } catch {}
        const common = path.join(lib, 'common');
        const dir = installdir ? path.resolve(common, installdir) : null;
        // Only ever a folder inside steamapps\common, never common itself.
        const inside = dir && path.relative(common, dir) && !path.relative(common, dir).startsWith('..') && !path.isAbsolute(path.relative(common, dir));
        targets.push({ appid, lib, manifest, dir: inside ? dir : null });
      }
    }
    const wasRunning = await this.steamProcess();
    this.restartingSteam = true;
    this.publish(true);
    const removed = [];
    try {
      await this.stopSteam();
      for (const t of targets) {
        const paths = [
          t.manifest,
          t.dir,
          path.join(t.lib, 'downloading', t.appid),
          path.join(t.lib, 'temp', t.appid),
          path.join(t.lib, 'shadercache', t.appid),
          path.join(t.lib, 'workshop', 'content', t.appid),
          path.join(t.lib, 'workshop', `appworkshop_${t.appid}.acf`),
        ].filter(Boolean);
        for (const p of paths) await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
        if (!fs.existsSync(t.manifest)) removed.push(t.appid);
      }
    } finally {
      try {
        if (wasRunning) await this.startSteam();
      } finally {
        this.restartingSteam = false;
        await this.readAllManifests().catch(() => {});
        this.publish(true);
      }
    }
    return removed;
  }

  /** Every visible titled window of Steam's interface. */
  async steamWindows() {
    if (!this.system.available()) return [];
    try {
      const list = await this.system.request('appWindows', { name: 'steamwebhelper', title: '' }, 3000);
      return (list || []).filter((w) => w.visible && !w.minimized);
    } catch {
      return [];
    }
  }

  /**
   * Steam's install dialog: bring it to the front when it appears, and once
   * it is gone, put Steam's main window back in the tray if it came up with
   * it (unless it was open before), then hand the focus back to the launcher.
   */
  async followDialog(before, mainWasOpen) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let dialog = null;
    for (let i = 0; i < 60 && !dialog; i++) {
      await sleep(250);
      const main = await this.steamWindow();
      const fresh = (await this.steamWindows()).filter((w) => !before.has(w.hwnd) && (!main || w.hwnd !== main.hwnd));
      if (fresh.length) dialog = fresh[0];
    }
    if (!dialog) return;
    await this.system.request('fgSet', { hwnd: dialog.hwnd }, 3000).catch(() => {});
    // Wait for the user to answer it (up to a few minutes).
    for (let i = 0; i < 720; i++) {
      await sleep(250);
      const still = (await this.steamWindows()).some((w) => w.hwnd === dialog.hwnd);
      if (!still) break;
    }
    if (!mainWasOpen) {
      const main = await this.steamWindow();
      if (main && main.visible && !main.minimized) await this.system.request('windowCmd', { hwnd: main.hwnd, action: 'close' }, 3000).catch(() => {});
    }
    if (this.hooks.focus) this.hooks.focus();
  }

  /** Steam's main window (a steamwebhelper window titled "Steam"), or null. */
  async steamWindow() {
    try {
      const list = await this.system.request('appWindows', { name: 'steamwebhelper', title: 'Steam' }, 3000);
      return (list || []).find((w) => w.visible) || (list || [])[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Steam answers a steam:// link by showing its window on the Downloads page.
   * The launcher stays on top meanwhile, and the window goes back to how it
   * was: closed to the tray (its own X) if it was hidden, minimized if it was.
   */
  async quietly(send) {
    const before = this.system.available() ? await this.steamWindow() : null;
    const wasOpen = !!(before && before.visible && !before.minimized);
    if (this.hooks.cover) this.hooks.cover(true);
    try {
      await send();
      if (wasOpen || !this.system.available()) return;
      // Steam may still be bringing the window up when it is first seen (and then
      // show it again): keep at it until it has stayed away for a moment.
      let sentAt = 0;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const w = await this.steamWindow();
        if (!w || !w.visible || w.minimized) {
          if (sentAt && Date.now() - sentAt > 1500) break;
          continue;
        }
        await this.system.request('windowCmd', { hwnd: w.hwnd, action: before && before.visible ? 'minimize' : 'close' }, 3000).catch(() => {});
        sentAt = Date.now();
      }
    } finally {
      if (this.hooks.cover) this.hooks.cover(false);
    }
  }

  /** Hand a steam:// link (or a switch) to Steam through steam.exe, which passes it on to a running Steam. */
  async steamUrl(args) {
    const steamExe = path.join(this.steamPath, 'steam.exe');
    if (fs.existsSync(steamExe) && this.system.available()) await this.system.request('launch', { file: steamExe, args, cwd: this.steamPath }, 30000);
    else if (args.startsWith('steam://')) await shell.openExternal(args);
  }

  async steamProcess() {
    try {
      const procs = await this.system.request('procs', {}, 8000);
      return procs.some((p) => String(p.name).toLowerCase().replace(/\.exe$/, '') === 'steam');
    } catch {
      return this.steamRunning();
    }
  }

  /** Steam running and signed in; started in the tray if it isn't running. */
  async ensureSteam() {
    if (await this.steamProcess()) return;
    const since = Date.now() - 2000;
    await this.steamUrl('-silent');
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.signedInSince(since)) {
        await new Promise((r) => setTimeout(r, 3000)); // its library and downloads come up right after
        return;
      }
    }
    throw new Error('Steam didn’t sign in. Open Steam and sign in, then try again.');
  }

  /** Whether connection_log.txt says Steam signed in after `since`. */
  async signedInSince(since) {
    let fh;
    try {
      fh = await fsp.open(path.join(this.steamPath, 'logs', 'connection_log.txt'), 'r');
      const { size } = await fh.stat();
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[Logged On,/.exec(line);
        if (m && localTime(m[1]) >= since) return true;
      }
    } catch {
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    return false;
  }

  /** Steam didn't take an update request up: say so (it may want the user in its own window). */
  checkRequests() {
    if (!this.requests.size) return;
    const now = Date.now();
    const items = this.items();
    for (const [appid, at] of this.requests) {
      const i = items.find((x) => x.appid === appid);
      if (!i || ['queued', 'downloading', 'installing'].includes(i.status)) {
        this.requests.delete(appid); // under way, or done
        continue;
      }
      if (this.waitingSteam.has(appid) || now - at < START_TIMEOUT) continue;
      this.requests.delete(appid);
      this.notify({ title: `Steam didn't start the update`, body: `${i.name} · Open Steam › Downloads to start it.`, icon: 'info', gameId: i.gameId });
    }
  }

  /** Settings › Library › Update Steam Games Right Away: don't wait for Steam's schedule. */
  autoUpdate() {
    if (!this.settings.data.steamAutoUpdate || this.monitor.list().length || !this.steamRunning()) return;
    for (const i of this.items()) {
      if (i.status !== 'available' || !i.gameId) continue;
      const a = this.apps.get(i.appid);
      const key = (a && a.targetBuild) || 'any';
      if (this.autoAsked.get(i.appid) === key) continue;
      this.autoAsked.set(i.appid, key);
      this.update(i.appid).catch(() => {});
    }
  }
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

module.exports = { SteamDownloads };
