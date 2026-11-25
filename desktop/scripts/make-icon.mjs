// Regenerates build/icon.png and build/icon.ico from the SVG mark (needs `npm i -D sharp`).
// The generated files are committed, so this only matters if you change the logo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: sharp } = await import('sharp');
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="60" fill="#14DB91"/>
  <path d="M100 78v100l82-50z" fill="#0B0B0D" stroke="#0B0B0D" stroke-width="10" stroke-linejoin="round"/></svg>`);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
await fs.writeFile(path.join(here, 'build', 'icon.png'), await sharp(svg, { density: 384 }).resize(512, 512).png().toBuffer());
// ICO container with embedded PNGs (supported since Windows Vista)
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, e); header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
await fs.writeFile(path.join(here, 'build', 'icon.ico'), Buffer.concat([header, ...pngs]));
console.log('wrote build/icon.png and build/icon.ico');
