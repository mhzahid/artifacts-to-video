// Downloads the URLs in scripts/asset-mirror.txt into asset-mirror/<host>/<path>.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = (await fs.readFile(path.join(root, 'scripts/asset-mirror.txt'), 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
for (const url of list) {
  const u = new URL(url);
  const file = path.join(root, 'asset-mirror', u.hostname, decodeURIComponent(u.pathname));
  try {
    await fs.access(file); console.log('✓ cached ', url); continue;
  } catch {}
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
    console.log('↓ saved  ', url);
  } catch (e) { console.warn('✗ failed ', url, e.message); }
}
