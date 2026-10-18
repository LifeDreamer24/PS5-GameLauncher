// Puts libVIIPER.dll next to syshelper.exe: the VIIPER fork DualSense Client
// embeds (github.com/DualSenseClient/VIIPER, GPL-3.0), unchanged, from its
// pinned release. The helper runs the virtual controllers with it. The download
// is checked against the release's SHA-256 and skipped when the DLL is already
// there. --force fetches it again.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const TAG = 'v1.0.1';
const URL = `https://github.com/DualSenseClient/VIIPER/releases/download/${TAG}/libVIIPER-windows-amd64.zip`;
const ZIP_SHA256 = 'ac1281fea5663e20b554df0d2abf0868b2223ce664465a4b02cf74b3f1c470a9';
const DLL_SHA256 = '87bf15d6b25f7a4b082c8303448a26b046cb13a281c5f9ad830d6ee5be1cc47b';

const dir = path.join(__dirname, '..', 'main', 'native');
const dll = path.join(dir, 'libVIIPER.dll');
const licenses = path.join(dir, 'libVIIPER-licenses.txt');

if (process.platform !== 'win32') {
  console.log('libVIIPER: skipped (Windows only)');
  process.exit(0);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (!process.argv.includes('--force') && fs.existsSync(dll) && fs.existsSync(licenses) && sha256(dll) === DLL_SHA256) process.exit(0);

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'PS5GameLauncher-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(download(res.headers.location, file, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  console.log(`Fetching libVIIPER ${TAG} (DualSenseClient/VIIPER) ...`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'libviiper-'));
  try {
    const zip = path.join(work, 'libVIIPER-windows-amd64.zip');
    await download(URL, zip);
    if (sha256(zip) !== ZIP_SHA256) throw new Error('the download does not match the release checksum');
    const out = path.join(work, 'x');
    fs.mkdirSync(out);
    execFileSync('tar', ['-xf', zip, '-C', out], { stdio: 'inherit' });
    if (sha256(path.join(out, 'libVIIPER.dll')) !== DLL_SHA256) throw new Error('libVIIPER.dll does not match the expected checksum');
    fs.copyFileSync(path.join(out, 'libVIIPER.dll'), dll);
    fs.copyFileSync(path.join(out, 'licenses.txt'), licenses);
    console.log(`libVIIPER: ${TAG} in main/native`);
  } catch (err) {
    // The launcher still builds; passthrough then reports libVIIPER.dll as missing.
    console.warn(`libVIIPER: could not fetch it (${err.message}). Controller passthrough won't work in this build.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
