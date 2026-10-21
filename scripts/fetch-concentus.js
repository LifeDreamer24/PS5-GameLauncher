// Puts Concentus.dll next to syshelper.cs: Concentus, a C# port of the Opus
// codec (github.com/lostromb/concentus, Opus BSD licence), from its pinned
// NuGet package. The helper encodes the game's controller-speaker sound with it
// for a DualSense on Bluetooth, which only takes Opus. It must be there before
// syshelper.exe is built (scripts/build-native.js); without it the helper still
// builds, just without the Bluetooth speaker. The download is checked against a
// pinned SHA-256 and skipped when the DLL is already there. --force fetches it again.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const VERSION = '1.1.7';
const URL = `https://api.nuget.org/v3-flatcontainer/concentus/${VERSION}/concentus.${VERSION}.nupkg`;
const PKG_SHA256 = '80022c6c0346fc6dfc906fd34110396eb940a5aa5d0b7fb1ae14aecc0921bf78';
// The .NET Framework build in the package (portable-net45+win+wpa81+wp80).
const ENTRY = 'lib/portable-net45%2Bwin%2Bwpa81%2Bwp80/Concentus.dll';
const DLL_SHA256 = 'b536a1e869d447147333864451c51ceab4804957857dd97914751fba32ebe0cc';

const dir = path.join(__dirname, '..', 'main', 'native');
const dll = path.join(dir, 'Concentus.dll');
const notice = path.join(dir, 'Concentus-license.txt');

if (process.platform !== 'win32') {
  console.log('Concentus: skipped (Windows only)');
  process.exit(0);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (!process.argv.includes('--force') && fs.existsSync(dll) && fs.existsSync(notice) && sha256(dll) === DLL_SHA256) process.exit(0);

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
  console.log(`Fetching Concentus ${VERSION} (NuGet) ...`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'concentus-'));
  try {
    const pkg = path.join(work, `concentus.${VERSION}.nupkg`);
    await download(URL, pkg);
    if (sha256(pkg) !== PKG_SHA256) throw new Error('the download does not match the pinned checksum');
    const out = path.join(work, 'x');
    fs.mkdirSync(out);
    // Windows' own tar (bsdtar) reads zip files; another tar first on the PATH (Git's) may not.
    const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(fs.existsSync(winTar) ? winTar : 'tar', ['-xf', pkg, '-C', out, ENTRY], { stdio: 'inherit' });
    const extracted = path.join(out, ...ENTRY.split('/'));
    if (sha256(extracted) !== DLL_SHA256) throw new Error('Concentus.dll does not match the expected checksum');
    fs.copyFileSync(extracted, dll);
    fs.writeFileSync(
      notice,
      [
        `Concentus ${VERSION}: a C# port of the Opus audio codec.`,
        'https://github.com/lostromb/concentus (NuGet: Concentus)',
        'Copyright (c) Xiph.Org Foundation, Skype Limited, CSIRO, Microsoft Corp.',
        'Licensed under the Opus licence (BSD 3-clause): https://opus-codec.org/license/',
        '',
      ].join('\r\n')
    );
    console.log(`Concentus: ${VERSION} in main/native`);
  } catch (err) {
    console.warn(`Concentus: could not fetch it (${err.message}). The DualSense speaker won't work over Bluetooth in this build.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
