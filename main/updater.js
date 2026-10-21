// Launcher updates from the GitHub Releases page (Settings › System › Software
// Update). The newest published release (pre-releases too, no drafts) is
// compared with this version; its "…Setup….exe" is downloaded, checked
// against the SHA-512 that electron-builder writes into latest.yml (uploaded
// with the release), and run silently once the launcher has closed:
//   Setup.exe /S --updated --force-run
// /S installs without pages over the existing installation (same folder,
// settings and library kept), --updated skips the "Extras" page
// (build/installer.nsh) and --force-run starts the launcher again.
// A copy unpacked from the zip has no installer to run: it only learns of the
// update and opens the download page.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

const REPO = 'arisqz/PS5-GameLauncher';
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const PAGE = `https://github.com/${REPO}/releases/latest`;
const AUTO_EVERY = 6 * 60 * 60 * 1000;

/** "v1.2.0-beta" -> [1, 2, 0, "beta"]; null when it isn't a version. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0), m[4] || ''] : null;
}

/** Semver order: 1.1.0 > 1.1.0-beta > 1.0.0. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3].localeCompare(y[3], undefined, { numeric: true });
}

/** Markdown of the release notes as plain lines for the UI. */
function plainNotes(md) {
  return String(md || '')
    .replace(/\r/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

class Updater {
  constructor({ send, settings }) {
    this.send = send;
    this.settings = settings;
    this.timer = null;
    this.busy = null;
    this.state = {
      current: app.getVersion(),
      installable: this.installable(),
      status: 'idle', // idle | checking | none | available | downloading | ready | installing | error
      latest: null, // { version, tag, name, notes, url, size, published, asset }
      progress: 0,
      checked: 0,
      error: null,
    };
  }

  /** Installed with the setup (it left its uninstaller next to the launcher), not run from the zip. */
  installable() {
    if (!app.isPackaged) return false;
    const dir = path.dirname(process.execPath);
    try {
      return fs.readdirSync(dir).some((f) => /^Uninstall .*\.exe$/i.test(f));
    } catch {
      return false;
    }
  }

  publicState() {
    return { ...this.state };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.send('update:state', this.publicState());
  }

  /** Check at startup and every few hours when Settings › System › Check Automatically is on. */
  start() {
    clearTimeout(this.timer);
    const run = async () => {
      if (this.settings.data.autoUpdateCheck !== false && this.state.status !== 'downloading' && this.state.status !== 'ready') {
        const before = this.state.latest && this.state.latest.version;
        await this.check().catch(() => {});
        const l = this.state.latest;
        if (this.state.status === 'available' && l && l.version !== before) {
          this.send('notify', { title: 'Update available', body: `PS5 Game Launcher ${l.version}`, icon: 'download', kind: 'system' });
        }
      }
      this.timer = setTimeout(run, AUTO_EVERY);
    };
    this.timer = setTimeout(run, 15000);
  }

  stop() {
    clearTimeout(this.timer);
  }

  async fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'PS5GameLauncher', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub asked to wait a moment. Try again later.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    return res.json();
  }

  /** Is there a newer release than this version? */
  check() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.set({ status: 'checking', error: null });
      try {
        const list = await this.fetchJson(RELEASES);
        const releases = (Array.isArray(list) ? list : []).filter((r) => !r.draft && parseVersion(r.tag_name));
        releases.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
        const r = releases[0];
        if (!r || compareVersions(r.tag_name, this.state.current) <= 0) {
          this.set({ status: 'none', latest: null, checked: Date.now() });
          return this.publicState();
        }
        const asset = (r.assets || []).find((a) => /setup.*\.exe$/i.test(a.name));
        const yml = (r.assets || []).find((a) => /^latest\.yml$/i.test(a.name));
        this.set({
          status: 'available',
          checked: Date.now(),
          latest: {
            version: String(r.tag_name).replace(/^v/, ''),
            tag: r.tag_name,
            name: r.name || r.tag_name,
            notes: plainNotes(r.body),
            url: r.html_url || PAGE,
            published: r.published_at,
            size: asset ? asset.size : 0,
            asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
            yml: yml ? yml.browser_download_url : null,
          },
        });
      } catch (err) {
        const msg = err && err.name === 'TimeoutError' ? 'GitHub can’t be reached. Check the internet connection.' : String((err && err.message) || err);
        this.set({ status: 'error', error: /fetch failed/i.test(msg) ? 'GitHub can’t be reached. Check the internet connection.' : msg });
      } finally {
        this.busy = null;
      }
      return this.publicState();
    })();
    return this.busy;
  }

  /** The SHA-512 (base64) latest.yml gives for the setup, if the release has it. */
  async expectedHash(l) {
    if (!l.yml) return null;
    try {
      const res = await fetch(l.yml, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const text = await res.text();
      const name = l.asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // The entry under files: whose url is this setup, else the top-level sha512.
      const entry = new RegExp(`url:\\s*${name}\\s*\\n\\s*sha512:\\s*(\\S+)`).exec(text);
      const top = /^sha512:\s*(\S+)/m.exec(text);
      return (entry && entry[1]) || (top && top[1]) || null;
    } catch {
      return null;
    }
  }

  /** Download the setup (with progress) and check it. */
  async download() {
    const l = this.state.latest;
    if (!l) throw new Error('Check for updates first.');
    if (!this.state.installable || !l.asset) {
      shell.openExternal(l.url || PAGE);
      return this.publicState();
    }
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.publicState();
    const dir = path.join(app.getPath('temp'), 'PS5GameLauncher-update');
    const file = path.join(dir, l.asset.name);
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      fs.mkdirSync(dir, { recursive: true });
      const res = await fetch(l.asset.url);
      if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
      const total = Number(res.headers.get('content-length')) || l.asset.size || 0;
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(file);
      let done = 0;
      let shown = 0;
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        done += chunk.length;
        const p = total ? done / total : 0;
        if (p - shown >= 0.01) {
          shown = p;
          this.set({ progress: p });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      const want = await this.expectedHash(l);
      if (want && hash.digest('base64') !== want) {
        fs.rmSync(file, { force: true });
        throw new Error('The download doesn’t match the release (its checksum differs). Try again.');
      }
      this.file = file;
      this.set({ status: 'ready', progress: 1, verified: !!want });
    } catch (err) {
      this.set({ status: 'error', error: String((err && err.message) || err) });
    }
    return this.publicState();
  }

  /**
   * Close the launcher and install: a hidden PowerShell waits for the launcher
   * and its helper to exit (the helper's files are being replaced), then runs
   * the setup silently, which starts the new launcher at the end.
   */
  install(quit) {
    if (this.state.status !== 'ready' || !this.file || !fs.existsSync(this.file)) throw new Error('Download the update first.');
    this.set({ status: 'installing' });
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const script = [
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      `Wait-Process -Name syshelper -Timeout 15 -ErrorAction SilentlyContinue`,
      `Start-Sleep -Milliseconds 500`,
      `Start-Process -FilePath ${q(this.file)} -ArgumentList '/S','--updated','--force-run'`,
    ].join('; ');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(quit, 300);
    return true;
  }
}

module.exports = { Updater, compareVersions, parseVersion };
