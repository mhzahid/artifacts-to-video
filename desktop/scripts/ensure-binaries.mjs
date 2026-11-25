// Makes sure the native binaries that npm packages normally fetch in their "install" scripts are
// really there. Some npm setups skip install scripts (ignore-scripts, or newer npm versions that
// don't run dependency scripts by default). Without this check the app builds fine but can't encode
// (no ffmpeg.exe), and `npm start` can't find Electron.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(here, 'package.json'));
const runInstall = (pkg) => {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  console.log(`> running ${pkg}'s download step…`);
  execFileSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: 'inherit' });
};

// 1) FFmpeg (ffmpeg-static)
let ffmpeg = require('ffmpeg-static');
if (!ffmpeg || !fs.existsSync(ffmpeg)) {
  runInstall('ffmpeg-static');
  ffmpeg = require('ffmpeg-static');
}
if (!ffmpeg || !fs.existsSync(ffmpeg)) {
  console.error(`\n✗ FFmpeg is missing (${ffmpeg}).\n  The download from GitHub failed. Check your internet connection or proxy, then run:\n    node node_modules/ffmpeg-static/install.js\n`);
  process.exit(1);
}
const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0];
const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const missing = ['libx264', 'libvpx-vp9', 'prores_ks', 'aac', 'libopus'].filter((e) => !encoders.includes(e));
if (missing.length) { console.error(`✗ ${version} is missing encoders: ${missing.join(', ')}`); process.exit(1); }
console.log(`✓ ${version} (${ffmpeg})`);

// 2) Electron binary (needed for `npm start`; electron-builder downloads its own copy for packaging)
const electronDir = path.dirname(require.resolve('electron/package.json'));
if (!fs.existsSync(path.join(electronDir, 'path.txt'))) runInstall('electron');
if (!fs.existsSync(path.join(electronDir, 'path.txt'))) {
  console.error('✗ The Electron binary could not be downloaded. Run: node node_modules/electron/install.js');
  process.exit(1);
}
console.log(`✓ Electron ${require('electron/package.json').version}`);
