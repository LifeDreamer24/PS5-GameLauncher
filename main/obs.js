// Recording and clips through OBS Studio, run silently in the background.
//
// The launcher starts OBS minimized to the tray and drives it over OBS's
// built-in WebSocket server (obs-websocket 5). It uses its own profile and
// scene collection ("PS5 Game Launcher") with a single Game Capture source,
// so the user's own OBS setup is left alone; the previous profile and
// collection are switched back when the launcher closes OBS again.
//
// While a game runs, OBS keeps a replay buffer (the last N seconds), so
// "Save Recent Gameplay" never has to pause or interrupt the game.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const encoders = require('./encoders');

const NAME = 'PS5 Game Launcher'; // profile and scene collection
const PROFILE_DIR = 'PS5_Game_Launcher';
const SCENE = 'Game';
const CAPTURE = 'Game Capture';
const VIDEO_EXT = /\.(mp4|mkv|mov)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || ''))));

/** "Horizon: Zero Dawn™" -> "Horizon Zero Dawn" (safe in file names). */
function safeName(s) {
  return String(s || 'Game')
    .replace(/[™®©]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Game';
}

/** Length of a video in seconds, from the file's header (MP4/MOV: mvhd, MKV: Segment Info). Null if unknown. */
async function videoSeconds(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const read = async (pos, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    if (/\.mkv$/i.test(file)) return mkvSeconds(await read(0, Math.min(size, 256 * 1024)));
    return await mp4Seconds(read, size);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function mp4Seconds(read, size) {
  // Walk the boxes: top level to 'moov' (OBS writes it at the end), then to its 'mvhd'.
  const find = async (start, end, want) => {
    for (let pos = start; pos + 8 <= end; ) {
      const head = await read(pos, 16);
      if (head.length < 8) return null;
      let len = head.readUInt32BE(0);
      let hdr = 8;
      if (len === 1 && head.length >= 16) {
        len = Number(head.readBigUInt64BE(8));
        hdr = 16;
      } else if (len === 0) len = end - pos;
      if (len < hdr) return null;
      if (head.toString('latin1', 4, 8) === want) return { start: pos + hdr, end: pos + len };
      pos += len;
    }
    return null;
  };
  const moov = await find(0, size, 'moov');
  const mvhd = moov && (await find(moov.start, moov.end, 'mvhd'));
  if (!mvhd) return null;
  const b = await read(mvhd.start, 32);
  if (b.length < 32) return null;
  const v1 = b[0] === 1;
  const scale = b.readUInt32BE(v1 ? 20 : 12);
  const dur = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
  return scale && dur ? dur / scale : null;
}

function mkvSeconds(buf) {
  let pos = 0;
  // EBML variable-length integers: IDs keep their length marker, sizes don't.
  const vint = (id) => {
    const first = buf[pos];
    if (first === undefined) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || pos + len > buf.length) return null;
    let val = id ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) val = val * 256 + buf[pos + i];
    pos += len;
    return !id && val === 2 ** (7 * len) - 1 ? Infinity : val;
  };
  let scale = 1000000; // TimecodeScale default: 1 ms
  let duration = null;
  while (pos < buf.length) {
    const id = vint(true);
    const size = vint(false);
    if (id === null || size === null) break;
    if (id === 0x18538067 || id === 0x1549a966) continue; // Segment, Info: look inside
    if (size === Infinity || pos + size > buf.length) break;
    if (id === 0x2ad7b1) {
      scale = 0;
      for (let i = 0; i < size; i++) scale = scale * 256 + buf[pos + i];
    } else if (id === 0x4489) duration = size === 4 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos);
    pos += size;
  }
  return duration && scale ? (duration * scale) / 1e9 : null;
}

const roundSeconds = (s) => (s ? Math.round(s * 10) / 10 : null);

/** OBS window string "title:class:exe" (":" escaped as #3A). */
function obsWindow(title, cls, exe) {
  const esc = (s) => String(s || '').replace(/#/g, '#22').replace(/:/g, '#3A');
  return `${esc(title)}:${esc(cls)}:${esc(exe)}`;
}

class ObsBridge extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {import('./store').JsonStore} o.settings
   * @param {(channel: string, payload: any) => void} o.send
   * @param {import('./system').SystemBridge} o.system
   * @param {() => string} o.defaultDir
   */
  constructor({ dataDir, settings, send, system, defaultDir }) {
    super();
    this.settings = settings;
    this.send = send;
    this.system = system;
    this.defaultDir = defaultDir;
    this.file = path.join(dataDir, 'obs.json');
    this.indexFile = path.join(dataDir, 'captures.json');
    this.thumbDir = path.join(dataDir, 'capture-thumbs');
    this.store = this.load(this.file, {});
    this.index = this.load(this.indexFile, []);
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
    this.busy = null; // the running ensure() call
    this.game = null; // { id, name, pid }
    this.recordSince = 0;
    this.replaySince = 0;
    this.durations = new Map(); // "file|size|mtime" -> seconds, for files outside the index
    this.state = { enabled: false, installed: null, status: 'off', error: null, replay: false, recording: false, hooked: false, version: null };
  }

  load(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  save(file, data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {}
  }

  get dir() {
    return this.settings.data.captureDir || this.defaultDir();
  }

  publicState() {
    return { ...this.state, recordSince: this.recordSince || 0, dir: this.dir, game: this.game ? this.game.name : null };
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.send('capture:state', this.publicState());
  }

  /* -------------------------------------------------------------- */
  /* Finding and starting OBS                                       */
  /* -------------------------------------------------------------- */

  async findObs() {
    let dir = null;
    const reg = await run('reg', ['query', 'HKLM\\SOFTWARE\\OBS Studio', '/ve']);
    const m = reg.match(/REG_SZ\s+(.+)\s*$/m);
    if (m) dir = m[1].trim();
    const candidates = [dir, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'obs-studio')].filter(Boolean);
    for (const d of candidates) {
      const exe = path.join(d, 'bin', '64bit', 'obs64.exe');
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }

  async obsPids() {
    try {
      const procs = await this.system.request('procs', {}, 8000);
      return procs.filter((p) => String(p.name).toLowerCase() === 'obs64').map((p) => p.pid);
    } catch {
      const out = await run('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH']);
      return [...out.matchAll(/"obs64\.exe","(\d+)"/gi)].map((x) => Number(x[1]));
    }
  }

  /**
   * OBS leaves a marker in .sentinel while it runs; one left behind (OBS was
   * killed) makes the next start wait at a "Crash detected" dialog. OBS is not
   * running here, so any marker is stale.
   */
  clearCrashMarkers() {
    const dir = path.join(process.env.APPDATA || '', 'obs-studio', '.sentinel');
    try {
      for (const f of fs.readdirSync(dir)) if (/^run_/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }

  wsConfigFile() {
    return path.join(process.env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
  }

  /**
   * Turn OBS's WebSocket server on (only while OBS is closed: OBS writes the
   * file itself on exit). A password the user already set is kept.
   */
  prepareWebsocket() {
    const file = this.wsConfigFile();
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (cfg.server_enabled && cfg.auth_required && cfg.server_password) {
      this.store.password = cfg.server_password;
      this.store.port = cfg.server_port || 4455;
    } else {
      this.store.password = this.store.password || crypto.randomBytes(12).toString('base64url');
      this.store.port = cfg.server_port || 4455;
      Object.assign(cfg, { server_enabled: true, auth_required: true, server_password: this.store.password, server_port: this.store.port, first_load: false });
      this.save(file, cfg);
    }
    this.save(this.file, this.store);
  }

  /** Start OBS (or reuse the one the launcher started before) and connect. */
  async start() {
    const exe = await this.findObs();
    this.setState({ installed: !!exe });
    if (!exe) throw Object.assign(new Error('OBS Studio is not installed.'), { status: 'missing' });

    const pids = await this.obsPids();
    if (pids.length) {
      // OBS is open. Only use it if the launcher started it (it keeps its pid).
      if (!this.store.pid || !pids.includes(this.store.pid)) {
        throw Object.assign(new Error('OBS is already open. Close it so the launcher can record in the background.'), { status: 'busy' });
      }
    } else {
      this.prepareWebsocket();
      this.clearCrashMarkers();
      this.loadedHash = await this.writeProfile();
      // Not windowsHide: that would also hide OBS's own dialogs. OBS puts
      // itself in the tray (--minimize-to-tray).
      const child = spawn(exe, ['--minimize-to-tray', '--disable-shutdown-check', '--disable-updater', '--disable-missing-files-check'], {
        cwd: path.dirname(exe),
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      this.store.pid = child.pid;
      this.save(this.file, this.store);
    }
    // OBS takes a few seconds to bring its WebSocket server up.
    let lastErr = null;
    for (let i = 0; i < 40; i++) {
      try {
        await this.connect();
        await this.whenLoaded();
        return;
      } catch (err) {
        lastErr = err;
        if (/authentication/i.test(err.message)) break;
        await sleep(500);
      }
    }
    throw lastErr || new Error('OBS did not answer.');
  }

  /* -------------------------------------------------------------- */
  /* obs-websocket 5                                                */
  /* -------------------------------------------------------------- */

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.store.port || 4455}`, 'obswebsocket.json');
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        try {
          ws.close();
        } catch {}
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('OBS did not answer.')), 4000);
      ws.onerror = () => fail(new Error('OBS is not reachable.'));
      ws.onclose = (e) => {
        if (!done) fail(new Error(e.code === 4009 ? 'OBS authentication failed.' : 'OBS closed the connection.'));
        else if (this.ws === ws) this.onDisconnected();
      };
      ws.onmessage = (m) => {
        let msg;
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        if (msg.op === 0) {
          // Hello: authenticate.
          const ident = { rpcVersion: 1, eventSubscriptions: 1 | 64 };
          const a = msg.d.authentication;
          if (a) {
            const secret = crypto.createHash('sha256').update(this.store.password + a.salt).digest('base64');
            ident.authentication = crypto.createHash('sha256').update(secret + a.challenge).digest('base64');
          }
          this.state.version = msg.d.obsStudioVersion || msg.d.obsWebSocketVersion || null;
          ws.send(JSON.stringify({ op: 1, d: ident }));
        } else if (msg.op === 2) {
          clearTimeout(timer);
          done = true;
          this.ws = ws;
          resolve();
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          clearTimeout(p.timer);
          if (msg.d.requestStatus.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(msg.d.requestStatus.comment || `OBS refused ${msg.d.requestType}`));
        } else if (msg.op === 5) {
          this.onEvent(msg.d.eventType, msg.d.eventData || {});
        }
      };
    });
  }

  /** The WebSocket server answers before OBS has loaded its scenes ("not ready"). */
  async whenLoaded() {
    for (let i = 0; i < 60; i++) {
      try {
        await this.request('GetSceneCollectionList');
        return;
      } catch (err) {
        if (!/not ready/i.test(err.message)) throw err;
        await sleep(500);
      }
    }
    throw new Error('OBS is taking too long to start.');
  }

  request(requestType, requestData = {}, timeout = 10000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Not connected to OBS.'));
    return new Promise((resolve, reject) => {
      const requestId = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS: ${requestType} timed out`));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  onDisconnected() {
    this.ws = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('OBS closed.'));
    }
    this.pending.clear();
    this.recordSince = 0;
    this.ownSetup = false;
    this.targetWindow = null;
    this.unwatch();
    if (this.state.status === 'ready') this.setState({ status: 'off', replay: false, recording: false, hooked: false, error: 'OBS was closed.' });
  }

  onEvent(type, d) {
    if (type === 'ReplayBufferStateChanged') {
      if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.replaySince = Date.now();
      if (!d.outputActive) this.replaySince = 0;
      this.setState({ replay: !!d.outputActive });
    }
    else if (type === 'RecordStateChanged') {
      if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.recordSince = Date.now();
      if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') this.recordSince = 0;
      this.setState({ recording: !!d.outputActive });
    } else if (type === 'ReplayBufferSaved') this.emit('replaySaved', d.savedReplayPath);
    else if (type === 'ExitStarted') this.onDisconnected();
  }

  /* -------------------------------------------------------------- */
  /* Our OBS profile (written as a file)                            */
  /* -------------------------------------------------------------- */
  // OBS builds its outputs (the replay buffer included) when it loads a
  // profile, and asks to restart when a profile's audio format differs from
  // the current one. So the launcher writes its profile file itself, with the
  // audio format of the user's own profile, before OBS loads it.

  obsDir() {
    return path.join(process.env.APPDATA || '', 'obs-studio');
  }

  readIni(file) {
    const out = {};
    let sec = null;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    } catch {
      return out;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\[(.+)\]$/.exec(line.trim());
      if (m) out[(sec = m[1])] = out[m[1]] || {};
      else if (sec && line.includes('=')) {
        const i = line.indexOf('=');
        out[sec][line.slice(0, i)] = line.slice(i + 1);
      }
    }
    return out;
  }

  writeIni(file, ini) {
    const text = Object.entries(ini)
      .map(([sec, kv]) => `[${sec}]\r\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\r\n')}\r\n`)
      .join('\r\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `﻿${text}`);
  }

  profileFile(dirName) {
    return path.join(this.obsDir(), 'basic', 'profiles', dirName, 'basic.ini');
  }

  /** The folder of the profile the user has selected in OBS (not ours). */
  userProfileDir() {
    const user = this.readIni(path.join(this.obsDir(), 'user.ini'));
    const global = this.readIni(path.join(this.obsDir(), 'global.ini'));
    const dir = (user.Basic && user.Basic.ProfileDir) || (global.Basic && global.Basic.ProfileDir);
    if (dir && dir !== PROFILE_DIR) return dir;
    try {
      return fs.readdirSync(path.join(this.obsDir(), 'basic', 'profiles')).find((d) => d !== PROFILE_DIR) || null;
    } catch {
      return null;
    }
  }

  /**
   * Our profile's settings from Settings › Captures. OBS's advanced output
   * mode, so the encoder and all of its settings can be chosen (the simple
   * mode only has a few quality steps). _encoder is the encoder's own
   * settings (recordEncoder.json), not part of basic.ini.
   */
  async profileSettings() {
    const s = this.settings.data;
    const seconds = Number(s.captureClipLength) || 60;
    const encoder = await this.encoder();
    const enc = this.encoderSettings(encoder);
    // The replay buffer's memory: enough for its length at the bitrate (quality
    // modes have none: room for 150 Mbps then).
    const peak = encoders.usesBitrate(encoder, enc) ? Math.max(Number(enc.bitrate) || 0, Number(enc.max_bitrate) || 0) * 1.25 : 150000;
    const format = ['mp4', 'mkv', 'hybrid_mp4'].includes(s.captureFormat) ? s.captureFormat : 'mp4';
    const { width, height } = this.screenSize();
    const target = Number(s.captureResolution) || 0; // 0 = same as the screen
    const outH = target && target < height ? target : height;
    const outW = Math.round((width * outH) / height / 2) * 2;
    const userIni = this.readIni(this.profileFile(this.userProfileDir() || 'Untitled'));
    const audio = userIni.Audio || {};
    const rbSize = String(Math.max(512, Math.ceil((seconds * peak) / 8 / 1000)));
    return {
      General: { Name: NAME },
      Output: { Mode: 'Advanced', FilenameFormatting: '%CCYY-%MM-%DD %hh-%mm-%ss' },
      AdvOut: {
        RecType: 'Standard',
        RecFilePath: this.dir,
        RecFormat2: format,
        Encoder: encoder,
        RecEncoder: encoder,
        RecUseRescale: 'false',
        RecTracks: '1',
        AudioEncoder: 'ffmpeg_aac',
        RecAudioEncoder: 'ffmpeg_aac',
        Track1Bitrate: '192',
        RecRB: 'true',
        RecRBTime: String(seconds),
        RecRBSize: rbSize,
      },
      // The replay buffer's file names come from here in both modes.
      SimpleOutput: { FilePath: this.dir, RecRB: 'true', RecRBTime: String(seconds), RecRBSize: rbSize, RecRBPrefix: 'Clip' },
      Video: { BaseCX: String(width), BaseCY: String(height), OutputCX: String(outW), OutputCY: String(outH), FPSType: '1', FPSInt: String(Number(s.captureFps) || 60), ScaleType: 'bicubic' },
      Audio: {
        SampleRate: audio.SampleRate || '48000',
        ChannelSetup: audio.ChannelSetup || 'Stereo',
        ...(audio.MonitoringDeviceId ? { MonitoringDeviceId: audio.MonitoringDeviceId, MonitoringDeviceName: audio.MonitoringDeviceName || 'Default' } : {}),
      },
      _encoder: enc,
    };
  }

  /** Write our settings into the profile file (OBS must not have it loaded). Returns their hash. */
  async writeProfile() {
    const ours = await this.profileSettings();
    const file = this.profileFile(PROFILE_DIR);
    const ini = this.readIni(file);
    for (const [sec, kv] of Object.entries(ours)) if (!sec.startsWith('_')) ini[sec] = { ...(ini[sec] || {}), ...kv };
    this.writeIni(file, ini);
    // The encoder's own settings (advanced mode reads them from these files).
    const json = JSON.stringify(ours._encoder, null, 2);
    fs.writeFileSync(path.join(path.dirname(file), 'recordEncoder.json'), json);
    fs.writeFileSync(path.join(path.dirname(file), 'streamEncoder.json'), json);
    return crypto.createHash('sha1').update(JSON.stringify(ours)).digest('hex');
  }

  async profilesHash() {
    return crypto.createHash('sha1').update(JSON.stringify(await this.profileSettings())).digest('hex');
  }

  /** Our own scene collection and profile (the user's current ones are remembered). */
  async useOwnSetup() {
    const cols = await this.request('GetSceneCollectionList');
    if (cols.currentSceneCollectionName !== NAME) {
      this.store.prevCollection = cols.currentSceneCollectionName;
      if (cols.sceneCollections.includes(NAME)) await this.request('SetCurrentSceneCollection', { sceneCollectionName: NAME }, 30000);
      else await this.request('CreateSceneCollection', { sceneCollectionName: NAME }, 30000);
      await sleep(800);
    }
    const profiles = await this.request('GetProfileList');
    if (profiles.currentProfileName !== NAME) {
      this.store.prevProfile = profiles.currentProfileName;
      // The file was written before OBS started, so OBS knows the profile.
      if (profiles.profiles.includes(NAME)) await this.request('SetCurrentProfile', { profileName: NAME }, 30000);
      else throw new Error('OBS did not pick up the launcher profile. Close OBS and try again.');
      await sleep(800);
    }
    this.save(this.file, this.store);

    const scenes = await this.request('GetSceneList');
    if (!scenes.scenes.some((s) => s.sceneName === SCENE)) await this.request('CreateScene', { sceneName: SCENE });
    await this.request('SetCurrentProgramScene', { sceneName: SCENE });
    const inputs = await this.request('GetInputList');
    if (!inputs.inputs.some((i) => i.inputName === CAPTURE)) {
      await this.request('CreateInput', {
        sceneName: SCENE,
        inputName: CAPTURE,
        inputKind: 'game_capture',
        inputSettings: { capture_mode: 'any_fullscreen', capture_audio: true },
      });
    }
  }

  /** The encoders OBS can use here (main/encoders.js), with what each can be set to. */
  async encoderList() {
    if (this.gpu === undefined) {
      const out = await run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "|"']);
      this.gpu = out.toLowerCase();
    }
    return encoders.available(this.obsDir(), this.gpu);
  }

  /**
   * The video encoder (an OBS encoder id): the one picked in Settings ›
   * Captures if OBS has it, else the hardware one for the chosen codec.
   * Before encoders were picked by id the setting was a vendor (amd, nvenc…).
   */
  async encoder() {
    const s = this.settings.data;
    const { encoders: list } = await this.encoderList();
    const want = s.captureEncoder || 'auto';
    if (list.some((e) => e.id === want)) return want;
    const codec = s.captureCodec || 'h264';
    const family = { amd: 'amf', nvenc: 'nvenc', qsv: 'qsv', x264: 'x264' }[want];
    const forCodec = list.filter((e) => e.codec === codec);
    const pick =
      (family && forCodec.find((e) => e.family === family)) ||
      forCodec.find((e) => e.hw) ||
      forCodec[0] ||
      list.find((e) => e.codec === 'h264' && e.hw) ||
      list.find((e) => e.id === 'obs_x264');
    return pick ? pick.id : 'obs_x264';
  }

  /**
   * An encoder's settings: what was set for it in Settings › Captures over its
   * defaults. Never set yet: the old quality setting decides (a bitrate for
   * "standard", else constant quality).
   */
  encoderSettings(id) {
    const s = this.settings.data;
    let own = (s.captureEnc || {})[id];
    if (!own) {
      const d = encoders.describe(id);
      if (d && s.captureQuality === 'standard') {
        const rc = d.rateControls.find((r) => r.value === 'CBR') || d.rateControls.find((r) => r.bitrate);
        own = { rate_control: rc ? rc.value : d.defaults.rate_control, bitrate: Number(s.captureBitrate) || 20000 };
      } else if (d && s.captureQuality === 'best') {
        const q = d.rateControls.find((r) => r.value === d.defaults.rate_control).quality;
        if (q) own = { [q]: Math.max(d.qualityMin, d.defaults[q] - 3) };
      }
    }
    return encoders.settingsFor(id, own);
  }

  /** For Settings › Captures: what can be chosen, and what is in use. */
  async encoderInfo() {
    const { encoders: list, fromObs } = await this.encoderList();
    const current = await this.encoder();
    const s = this.settings.data;
    return {
      encoders: list.map((e) => ({ ...e, ...encoders.describe(e.id) })),
      fromObs,
      current,
      codec: (encoders.BY_ID.get(current) || {}).codec || s.captureCodec || 'h264',
      chosen: list.some((e) => e.id === s.captureEncoder) ? s.captureEncoder : 'auto',
      settings: this.encoderSettings(current),
    };
  }

  /**
   * Settings › Captures changed (or a game starts): bring our profile up to
   * date. Changed output settings mean loading the profile again, which OBS
   * only allows while nothing records. Returns whether an output is busy.
   */
  async applySettings() {
    const s = this.settings.data;
    await fsp.mkdir(this.dir, { recursive: true }).catch(() => {});
    const busy = (await this.request('GetReplayBufferStatus').catch(() => ({}))).outputActive || (await this.request('GetRecordStatus')).outputActive;
    const hash = await this.profilesHash();
    if (!busy && hash !== this.loadedHash) {
      const other = this.store.prevProfile || (await this.request('GetProfileList')).profiles.find((p) => p !== NAME);
      if (other) {
        // Away (OBS saves our profile), rewrite the file, and back again.
        await this.request('SetCurrentProfile', { profileName: other }, 30000);
        await sleep(500);
        this.loadedHash = await this.writeProfile();
        await this.request('SetCurrentProfile', { profileName: NAME }, 30000);
        await sleep(800);
      }
    }
    await this.request('SetRecordDirectory', { recordDirectory: this.dir }).catch(() => {});

    // Audio: game audio through Game Capture, or all of the desktop; the mic optionally.
    const gameOnly = s.captureGameAudioOnly !== false;
    await this.request('SetInputSettings', { inputName: CAPTURE, inputSettings: { capture_audio: gameOnly } }).catch(() => {});
    const special = await this.request('GetSpecialInputs').catch(() => ({}));
    if (special.desktop1) await this.request('SetInputMute', { inputName: special.desktop1, inputMuted: gameOnly }).catch(() => {});
    if (special.mic1) await this.request('SetInputMute', { inputName: special.mic1, inputMuted: !s.captureMic }).catch(() => {});
    return busy;
  }

  /** "2026-10-12 19-00-21.mp4" -> "<Game> 2026-10-12 19-00-21.mp4" once OBS has let go of it. */
  async nameForGame(file) {
    const game = safeName(this.game && this.game.name);
    const base = path.basename(file).replace(/^Clip\s*/i, '');
    const ext = path.extname(base);
    let target = path.join(path.dirname(file), `${game} ${base}`);
    // Never replace another capture saved in the same second.
    for (let n = 2; fs.existsSync(target); n++) target = path.join(path.dirname(file), `${game} ${path.basename(base, ext)} (${n})${ext}`);
    for (let i = 0; i < 20; i++) {
      try {
        await fsp.rename(file, target);
        return target;
      } catch {
        await sleep(250);
      }
    }
    return file;
  }

  screenSize() {
    try {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay();
      return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    } catch {
      return { width: 1920, height: 1080 };
    }
  }

  /** OBS's own entry ("title:class:exe") for a window of this executable, from Game Capture's window list. */
  async windowFor(exe) {
    const want = String(exe || '').toLowerCase();
    if (!want) return null;
    const r = await this.request('GetInputPropertiesListPropertyItems', { inputName: CAPTURE, propertyName: 'window' }).catch(() => null);
    const parts = (v) => String(v).split(':').map((s) => s.replace(/#3A/g, ':').replace(/#22/g, '#'));
    // The list starts with the current setting when that window isn't open (disabled, maybe without a class): skip it.
    const hit = ((r && r.propertyItems) || []).find((i) => {
      const [, cls, file] = parts(i.itemValue || '');
      return i.itemEnabled !== false && cls && String(file || '').toLowerCase() === want;
    });
    return hit ? hit.itemValue : null;
  }

  /**
   * Point Game Capture at the running game's window. OBS matches the window
   * by its executable (priority 2), but it needs a title and a class too: with
   * those empty it never finds the window (no hook, black video).
   */
  async target(pid, { foreground = false } = {}) {
    let exe = '';
    try {
      exe = path.basename(String((await this.system.request('procPath', { pid }, 4000)) || ''));
    } catch {}
    this.targetExe = exe;
    let window = await this.windowFor(exe);
    let via = 'exe';
    if (!window && foreground) {
      // The game's own process has no window (started through a small launcher
      // process): take the big window in front, if it isn't the launcher's own.
      const fg = await this.system.foreground().catch(() => null);
      const big = fg && fg.w * fg.h >= 0.35 * (fg.mw || 1920) * (fg.mh || 1080);
      if (big && fg.pid !== process.pid && !/^(obs64|explorer)$/i.test(fg.name || '')) {
        window = await this.windowFor(`${fg.name}.exe`);
        via = 'foreground';
      }
    }
    if (!window && exe) window = obsWindow(exe, exe, exe); // not open yet: OBS keeps looking for the .exe
    const inputSettings = window ? { capture_mode: 'window', window, priority: 2 } : { capture_mode: 'any_fullscreen' };
    this.targetVia = via;
    if (this.targetWindow === (window || '*')) return;
    this.targetWindow = window || '*';
    await this.request('SetInputSettings', { inputName: CAPTURE, inputSettings });
  }

  /** Scale the capture to fill the canvas, whatever resolution the game runs at. */
  async fitCapture() {
    const v = await this.request('GetVideoSettings');
    const { sceneItemId } = await this.request('GetSceneItemId', { sceneName: SCENE, sourceName: CAPTURE });
    await this.request('SetSceneItemTransform', {
      sceneName: SCENE,
      sceneItemId,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: v.baseWidth, boundsHeight: v.baseHeight },
    });
  }

  /** Whether Game Capture has a picture (it reports a size only while hooked). */
  async hooked() {
    const { sceneItemId } = await this.request('GetSceneItemId', { sceneName: SCENE, sourceName: CAPTURE });
    const { sceneItemTransform: t } = await this.request('GetSceneItemTransform', { sceneName: SCENE, sceneItemId });
    return t.sourceWidth > 0 && t.sourceHeight > 0;
  }

  /** While a game runs: keep Game Capture on it, retargeting while OBS has no picture. */
  watch() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.checkHook().catch(() => {}), 3000);
  }

  unwatch() {
    clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.unhookedSince = 0;
  }

  async checkHook() {
    if (!this.ws || !this.ownSetup || !this.game || this.busy) return;
    const ok = await this.hooked();
    if (ok !== this.state.hooked) this.setState({ hooked: ok });
    const now = Date.now();
    if (ok) {
      this.unhookedSince = 0;
      // Took the window in front; switch to the game's own window once it has one.
      if (this.targetVia === 'foreground' && (await this.windowFor(this.targetExe))) await this.target(this.game.pid);
      return;
    }
    this.unhookedSince = this.unhookedSince || now;
    if (now - this.unhookedSince >= 6000) await this.target(this.game.pid, { foreground: now - this.unhookedSince >= 15000 });
  }

  /* -------------------------------------------------------------- */
  /* Lifecycle                                                      */
  /* -------------------------------------------------------------- */

  /** Bring OBS up and the replay buffer running for the current game. */
  ensure() {
    if (this.busy) return this.busy;
    this.busy = this._ensure().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async _ensure() {
    if (!this.settings.data.captureEnabled) return;
    try {
      if (!this.ws) {
        this.setState({ status: 'starting', error: null });
        await this.start();
      }
      // Never touch outputs before our own profile and collection are active.
      if (!this.ownSetup) {
        await this.useOwnSetup();
        this.ownSetup = true;
      }
      if (this.game) await this.target(this.game.pid);
      const busy = await this.applySettings();
      await this.fitCapture().catch(() => {});
      if (this.game) this.watch();
      if (this.game && !busy) await this.request('StartReplayBuffer').catch(() => {});
      const rb = await this.request('GetReplayBufferStatus');
      const rec = await this.request('GetRecordStatus');
      this.setState({ status: 'ready', error: null, replay: !!rb.outputActive, recording: !!rec.outputActive });
    } catch (err) {
      this.setState({ status: err.status || 'error', error: err.message, replay: false });
    }
  }

  /** The running games changed (game monitor). */
  async onRunning(list, findGame) {
    const cur = [...list].sort((a, b) => b.since - a.since)[0];
    const next = cur ? { id: cur.id, pid: cur.pid, name: (findGame(cur.id) || {}).name || 'Game' } : null;
    const changed = (next && next.pid) !== (this.game && this.game.pid);
    this.game = next;
    if (!changed || !this.settings.data.captureEnabled) return;
    this.targetWindow = null;
    this.unhookedSince = 0;
    if (this.state.hooked) this.setState({ hooked: false });
    if (next) {
      // Settings (file names, video) can only change while the outputs are idle.
      if (this.ws) {
        await this.request('StopReplayBuffer').catch(() => {});
        await sleep(400);
      }
      await this.ensure();
    } else if (this.ws) {
      this.unwatch();
      if (this.state.recording) await this.toggleRecording().catch(() => {});
      await this.request('StopReplayBuffer').catch(() => {});
      this.setState({ replay: false });
    }
  }

  /** Settings › Captures changed. */
  async onSettings() {
    if (!this.settings.data.captureEnabled) {
      await this.shutdown();
      this.setState({ status: 'off', error: null });
      return;
    }
    if (this.ws && this.state.replay) {
      await this.request('StopReplayBuffer').catch(() => {});
      await sleep(400);
    }
    if (this.ws || this.game) await this.ensure();
    else this.setState({ status: 'idle', error: null, installed: !!(await this.findObs()) });
  }

  /** Close OBS again if the launcher started it, restoring the user's setup. */
  async shutdown() {
    this.unwatch();
    if (!this.ws) return;
    try {
      if (this.state.recording) await this.request('StopRecord').catch(() => {});
      await this.request('StopReplayBuffer').catch(() => {});
      if (this.store.prevCollection) await this.request('SetCurrentSceneCollection', { sceneCollectionName: this.store.prevCollection }, 30000).catch(() => {});
      if (this.store.prevProfile) await this.request('SetCurrentProfile', { profileName: this.store.prevProfile }, 30000).catch(() => {});
      delete this.store.prevCollection;
      delete this.store.prevProfile;
    } catch {}
    const pid = this.store.pid;
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.ownSetup = false;
    this.targetWindow = null;
    if (pid) {
      // A normal close request (OBS exits cleanly within a second or two).
      await run('taskkill', ['/PID', String(pid)]);
      for (let i = 0; i < 40 && (await this.obsPids()).includes(pid); i++) await sleep(500);
      if ((await this.obsPids()).includes(pid)) await run('taskkill', ['/PID', String(pid), '/F']);
    }
    delete this.store.pid;
    this.save(this.file, this.store);
    this.setState({ status: 'off', replay: false, recording: false, hooked: false });
  }

  /* -------------------------------------------------------------- */
  /* Captures                                                       */
  /* -------------------------------------------------------------- */

  ready() {
    if (!this.settings.data.captureEnabled) throw new Error('Turn on recording in Settings › Captures.');
    if (!this.game) throw new Error('Start a game to capture it.');
    if (!this.ws || !this.ownSetup) throw new Error(this.state.error || 'OBS is still starting.');
  }

  /** A small picture of the game right now (gallery thumbnail). */
  async thumbnail(forFile) {
    const name = `${path.basename(forFile)}.jpg`;
    const file = path.join(this.thumbDir, name);
    try {
      await fsp.mkdir(this.thumbDir, { recursive: true });
      await this.request('SaveSourceScreenshot', { sourceName: CAPTURE, imageFormat: 'jpg', imageFilePath: file, imageWidth: 480, imageCompressionQuality: 80 });
      return name;
    } catch {
      return null;
    }
  }

  addToIndex(entry) {
    this.index = [entry, ...this.index.filter((e) => e.file !== entry.file)].slice(0, 2000);
    this.save(this.indexFile, this.index);
  }

  /** Save the replay buffer ("Save Recent Gameplay"). */
  async saveClip() {
    this.ready();
    if (!this.state.replay) await this.request('StartReplayBuffer').catch(() => {});
    const saved = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      this.once('replaySaved', (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });
    await this.request('SaveReplayBuffer');
    let file = await saved;
    if (!file) file = (await this.request('GetLastReplayBufferReplay').catch(() => ({}))).savedReplayPath;
    if (!file) throw new Error('OBS did not save the clip.');
    file = await this.nameForGame(file);
    // The real length: shorter than the setting when the game hasn't been running that long.
    const max = Number(this.settings.data.captureClipLength) || 60;
    const probed = await videoSeconds(file);
    const seconds = probed || (this.replaySince ? Math.min(max, (Date.now() - this.replaySince) / 1000) : max);
    const entry = { file: path.basename(file), type: 'clip', game: this.game.name, gameId: this.game.id, time: Date.now(), thumb: await this.thumbnail(file), seconds: roundSeconds(seconds), probed: !!probed };
    this.addToIndex(entry);
    return this.describe(entry);
  }

  async screenshot() {
    this.ready();
    const ext = this.settings.data.captureShotFormat === 'jpg' ? 'jpg' : 'png';
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stem = `${safeName(this.game.name)} ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`;
    let name = `${stem}.${ext}`;
    for (let n = 2; fs.existsSync(path.join(this.dir, name)); n++) name = `${stem} (${n}).${ext}`;
    await fsp.mkdir(this.dir, { recursive: true });
    await this.request('SaveSourceScreenshot', { sourceName: CAPTURE, imageFormat: ext, imageFilePath: path.join(this.dir, name), imageCompressionQuality: 95 }).catch((err) => {
      // Game Capture has no picture (not hooked yet, or the game blocks capture).
      throw /render/i.test(err.message) ? new Error('The game isn’t being captured. Some games block capture tools.') : err;
    });
    const entry = { file: name, type: 'screenshot', game: this.game.name, gameId: this.game.id, time: Date.now(), thumb: null };
    this.addToIndex(entry);
    return this.describe(entry);
  }

  /** Start a recording, or stop the running one (returns the saved file then). */
  async toggleRecording() {
    this.ready();
    const st = await this.request('GetRecordStatus');
    if (!st.outputActive) {
      await this.request('StartRecord');
      this.recordSince = Date.now();
      this.setState({ recording: true });
      return { started: true };
    }
    const thumb = this.game ? await this.thumbnail(`rec-${Date.now()}`) : null;
    const since = this.recordSince;
    const r = await this.request('StopRecord', {}, 30000);
    this.recordSince = 0;
    this.setState({ recording: false });
    if (!r.outputPath) return { stopped: true };
    r.outputPath = await this.nameForGame(r.outputPath);
    let thumbName = null;
    if (thumb) {
      thumbName = `${path.basename(r.outputPath)}.jpg`;
      await fsp.rename(path.join(this.thumbDir, thumb), path.join(this.thumbDir, thumbName)).catch(() => {
        thumbName = thumb;
      });
    }
    const probed = await videoSeconds(r.outputPath);
    const seconds = probed || (since ? (Date.now() - since) / 1000 : null);
    const entry = { file: path.basename(r.outputPath), type: 'video', game: this.game ? this.game.name : '', gameId: this.game ? this.game.id : null, time: Date.now(), thumb: thumbName, seconds: roundSeconds(seconds), probed: !!probed };
    this.addToIndex(entry);
    return { stopped: true, capture: this.describe(entry) };
  }

  /* -------------------------------------------------------------- */
  /* Gallery                                                        */
  /* -------------------------------------------------------------- */

  describe(e) {
    const url = (root, f) => `app://${root}/${encodeURIComponent(f)}`;
    return { ...e, url: url('captures', e.file), thumbUrl: e.thumb ? url('capthumbs', e.thumb) : null, kind: IMAGE_EXT.test(e.file) ? 'image' : 'video' };
  }

  /** Everything in the captures folder, newest first (with what the index knows). */
  async list() {
    let names = [];
    try {
      names = (await fsp.readdir(this.dir)).filter((f) => VIDEO_EXT.test(f) || IMAGE_EXT.test(f));
    } catch {}
    const known = new Map(this.index.map((e) => [e.file, e]));
    const out = [];
    let dirty = false;
    for (const f of names) {
      let st;
      try {
        st = await fsp.stat(path.join(this.dir, f));
      } catch {
        continue;
      }
      let e = known.get(f) || { file: f, type: IMAGE_EXT.test(f) ? 'screenshot' : 'video', game: f.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').replace(/^Clip\s*/i, '') || '', time: st.mtimeMs, thumb: null };
      // Videos without a measured length (older clips, files from elsewhere): read it from the file once.
      if (VIDEO_EXT.test(f) && !e.probed) {
        const key = `${f}|${st.size}|${st.mtimeMs}`;
        if (!this.durations.has(key)) this.durations.set(key, await videoSeconds(path.join(this.dir, f)));
        const secs = this.durations.get(key);
        if (secs) {
          e = { ...e, seconds: roundSeconds(secs) };
          if (known.has(f)) {
            Object.assign(known.get(f), { seconds: e.seconds, probed: true });
            dirty = true;
          }
        }
      }
      out.push(this.describe({ ...e, size: st.size, time: e.time || st.mtimeMs }));
    }
    if (dirty) this.save(this.indexFile, this.index);
    return out.sort((a, b) => b.time - a.time);
  }

  /** Mark a capture as a favourite (Media Gallery › Favorites). */
  async setFavorite(file, on) {
    const name = path.basename(String(file || ''));
    if (!name || !(VIDEO_EXT.test(name) || IMAGE_EXT.test(name))) return false;
    let e = this.index.find((x) => x.file === name);
    if (!e) {
      // A file the launcher didn't save itself: it gets an entry to remember this.
      let time = Date.now();
      try {
        time = (await fsp.stat(path.join(this.dir, name))).mtimeMs;
      } catch {
        return false;
      }
      e = { file: name, type: IMAGE_EXT.test(name) ? 'screenshot' : 'video', game: name.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').replace(/^Clip\s*/i, '') || '', time, thumb: null };
      this.index.push(e);
    }
    if (on) e.favorite = true;
    else delete e.favorite;
    this.save(this.indexFile, this.index);
    return true;
  }

  /** Delete a capture (to the Recycle Bin). */
  async remove(file) {
    const name = path.basename(String(file || ''));
    if (!name || !(VIDEO_EXT.test(name) || IMAGE_EXT.test(name))) return false;
    const { shell } = require('electron');
    await shell.trashItem(path.join(this.dir, name));
    const e = this.index.find((x) => x.file === name);
    if (e && e.thumb) await fsp.rm(path.join(this.thumbDir, e.thumb), { force: true }).catch(() => {});
    this.index = this.index.filter((x) => x.file !== name);
    this.save(this.indexFile, this.index);
    return true;
  }
}

module.exports = { ObsBridge, safeName, obsWindow };
