// yt-dlp, for game theme music from YouTube (optional: setup's Extras page or
// Settings › Sound › Game Theme Music downloads it). It lives in the data
// folder (tools\yt-dlp.exe), comes from its official GitHub releases and is
// checked against the release's SHA2-256SUMS. YouTube needs a JavaScript
// runtime for yt-dlp; the launcher's own Electron serves as one (Node mode),
// so nothing else has to be downloaded.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const RELEASE = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const UPDATE_EVERY = 2 * 24 * 60 * 60 * 1000; // YouTube changes often; so does yt-dlp

class YtDlp {
  constructor({ dataDir, settings, send }) {
    this.dir = path.join(dataDir, 'tools');
    this.exe = path.join(this.dir, 'yt-dlp.exe');
    this.settings = settings;
    this.send = send;
    this.version = null;
    this.job = null; // install in progress
    this.progress = 0;
    this.error = null;
  }

  installed() {
    return fs.existsSync(this.exe);
  }

  async state() {
    if (this.installed() && !this.version) this.version = await this.readVersion();
    return { installed: this.installed(), version: this.version, installing: !!this.job, progress: this.progress, error: this.error };
  }

  async emit() {
    this.send('ytdlp:state', await this.state());
  }

  readVersion() {
    return new Promise((resolve) => {
      execFile(this.exe, ['--version'], { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
    });
  }

  /** Download (or replace) yt-dlp.exe from the latest release. */
  install() {
    if (this.job) return this.job;
    this.error = null;
    this.progress = 0;
    this.job = (async () => {
      const headers = { 'User-Agent': 'PS5GameLauncher', Accept: 'application/vnd.github+json' };
      const rel = await (await fetch(RELEASE, { headers, signal: AbortSignal.timeout(15000) })).json();
      const exe = (rel.assets || []).find((a) => a.name === 'yt-dlp.exe');
      const sums = (rel.assets || []).find((a) => a.name === 'SHA2-256SUMS');
      if (!exe || !sums) throw new Error('The yt-dlp release has no Windows download.');
      const list = await (await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(15000) })).text();
      const want = (/^([0-9a-f]{64})\s+\*?yt-dlp\.exe$/im.exec(list) || [])[1];
      if (!want) throw new Error('The yt-dlp release has no checksum for its download.');
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = this.exe + '.download';
      const res = await fetch(exe.browser_download_url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
      const total = Number(res.headers.get('content-length')) || exe.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp);
      let done = 0;
      let shown = 0;
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        done += chunk.length;
        if (total && done / total - shown >= 0.02) {
          shown = this.progress = done / total;
          this.emit();
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (hash.digest('hex') !== want.toLowerCase()) {
        await fsp.rm(tmp, { force: true });
        throw new Error('The yt-dlp download doesn’t match its checksum. Try again.');
      }
      await fsp.rename(tmp, this.exe);
      this.version = await this.readVersion();
      this.settings.data.ytdlpChecked = Date.now();
      this.settings.saveSoon();
    })()
      .catch((err) => {
        this.error = err && err.name === 'TimeoutError' ? 'GitHub can’t be reached. Check the internet connection.' : String((err && err.message) || err);
        throw err;
      })
      .finally(() => {
        this.job = null;
        this.progress = 0;
        this.emit();
      });
    this.emit();
    return this.job;
  }

  async remove() {
    await fsp.rm(this.exe, { force: true });
    await fsp.rm(path.join(this.dir, 'cache'), { recursive: true, force: true });
    this.version = null;
    this.emit();
  }

  /** Every couple of days (while theme music is on): a newer yt-dlp, quietly. */
  async updateIfDue() {
    if (!this.installed() || this.job || Date.now() - (this.settings.data.ytdlpChecked || 0) < UPDATE_EVERY) return;
    this.settings.data.ytdlpChecked = Date.now();
    this.settings.saveSoon();
    try {
      const rel = await (await fetch(RELEASE, { headers: { 'User-Agent': 'PS5GameLauncher' }, signal: AbortSignal.timeout(15000) })).json();
      const have = this.version || (await this.readVersion());
      if (rel.tag_name && have && rel.tag_name !== have) await this.install();
    } catch {}
  }

  /**
   * Run yt-dlp; resolves with its output. signal: an AbortSignal that stops it.
   * Electron runs as Node for YouTube's JavaScript challenges (yt-dlp ≥ Node 22).
   */
  run(args, { timeout = 60000, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.installed()) return reject(new Error('yt-dlp isn’t installed.'));
      const all = ['--ignore-config', '--no-warnings', '--cache-dir', path.join(this.dir, 'cache'), '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, ...args];
      const p = spawn(this.exe, all, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const stop = () => p.kill();
      const timer = setTimeout(stop, timeout);
      if (signal) signal.addEventListener('abort', stop, { once: true });
      p.on('error', reject);
      p.on('close', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', stop);
        if (signal && signal.aborted) reject(new Error('Stopped.'));
        else if (code === 0) resolve(out);
        else reject(new Error((err.trim().split('\n').pop() || `yt-dlp ended with code ${code}`).replace(/^ERROR:\s*/, '')));
      });
    });
  }
}

module.exports = { YtDlp };
