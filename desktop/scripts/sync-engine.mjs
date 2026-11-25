// Copies the shared render engine from the web app (../src, ../asset-mirror) into the desktop
// package, so both products run exactly the same capture code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(here, '..');
const copies = [
  ['src/render', 'engine/render'],
  ['src/jobs.js', 'engine/jobs.js'],
  ['asset-mirror', 'asset-mirror'],
  ['public/finishing.js', 'ui/finishing.js'], // presets + trim/fade/watermark/poster panels + output timeline, shared with the web UI
  ['public/base.css', 'ui/base.css'],         // design tokens and shared components (web and desktop look the same)
  ['public/fonts', 'ui/fonts'],               // Archivo, bundled so the desktop app works offline
];
for (const [from, to] of copies) {
  const dst = path.join(here, to);
  await fs.rm(dst, { recursive: true, force: true });
  await fs.cp(path.join(repo, from), dst, { recursive: true });
  console.log(`synced ${from} -> desktop/${to}`);
}
