#!/usr/bin/env node
// Usage: node src/cli.js input.html [out.mp4] [options]
//   --preset youtube1080|youtube4k|reels|feed45|square|landing|gif|master|preview
//   --format mp4|webm|mov|gif  --resolution 1080p  --aspect 16:9  --fps 30  --quality draft|standard|high
//   --no-sound  --duration 12.5  --start "#btn"  --hide "#ui"
//   --trim-start 2  --trim-end 10  --hold 2  --fade-in  --fade-out  --fade 0.5
//   --poster [seconds]  --watermark logo.png  --wm-pos br|bl|tr|tl|center  --wm-size 0.12  --wm-opacity 0.85
//   --audio music.mp3  --audio-mix replace|mix  --audio-volume 0.8  --audio-loop
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { render, closeBrowser } from './render/renderer.js';
import { probeAudio } from './render/encode.js';
import { normalizeOptions, PRESETS, PRESET_FIELDS } from './render/presets.js';

const argv = process.argv.slice(2);
const pos = [], o = {};
const FLAGS = { 'no-sound': ['sound', false], 'fade-in': ['fadeIn', true], 'fade-out': ['fadeOut', true], 'audio-loop': ['audioLoop', true] };
const NAMES = { start: 'startSelector', hide: 'hideSelectors', 'trim-start': 'trimStart', 'trim-end': 'trimEnd', fade: 'fadeDuration',
  'wm-pos': 'wmPos', 'wm-size': 'wmSize', 'wm-opacity': 'wmOpacity',
  'audio-mix': 'audioMix', 'audio-volume': 'audioVolume' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const k = a.slice(2);
  if (FLAGS[k]) o[FLAGS[k][0]] = FLAGS[k][1];
  else if (k === 'poster') { o.poster = true; if (argv[i + 1] && !argv[i + 1].startsWith('--') && isFinite(+argv[i + 1])) o.posterTime = argv[++i]; }
  else o[NAMES[k] || k] = argv[++i];
}
if (!pos[0]) { console.error('usage: node src/cli.js input.html [out.mp4] [options]  (see the top of src/cli.js)'); process.exit(1); }

// A preset fills the fields that weren't given explicitly.
if (o.preset && PRESETS[o.preset]) for (const f of PRESET_FIELDS) if (o[f] === undefined && PRESETS[o.preset][f] !== undefined) o[f] = PRESETS[o.preset][f];
const fmt = o.format || path.extname(pos[1] || '').slice(1) || 'mp4';
const opts = normalizeOptions({ ...o, format: fmt,
  watermark: o.watermark ? { enabled: true, position: o.wmPos, size: o.wmSize, opacity: o.wmOpacity } : null,
  audio: o.audio ? { track: 'cli', mix: o.audioMix, volume: o.audioVolume, loop: o.audioLoop } : null });
if (opts.watermark) opts.watermark.path = path.resolve(o.watermark);
if (opts.audio) {
  opts.audio.path = path.resolve(o.audio);
  opts.audio.name = path.basename(o.audio);
  try { await probeAudio(opts.audio.path); } catch (e) { console.error(e.message); process.exit(1); }
}
const out = path.resolve(pos[1] || pos[0].replace(/\.html?$/i, '') + '.' + opts.format);
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2v-'));
try {
  const r = await render({ htmlPath: pos[0], outPath: out, workDir, opts, assetDir: path.dirname(path.resolve(pos[0])), onProgress: (p) => {
    const msg = p.stage === 'capturing' ? `capturing ${p.frame}/${p.frames} (${p.fps.toFixed(1)} fps, eta ${Math.round(p.eta)}s)` : p.stage;
    process.stdout.write(`\r${msg.padEnd(60)}`);
  } });
  console.log('\n', r, '\n→', out);
} catch (e) { console.error('\n', e.message); process.exitCode = 1; }
finally { await fs.rm(workDir, { recursive: true, force: true }); await closeBrowser(); }
