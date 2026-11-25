import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { initScript } from './inject.js';
import { startFramePipe, finalize, wavHeader, run, checkFfmpeg, extractPoster } from './encode.js';
import { outputSize, LIMITS, ASPECTS } from './presets.js';

const ORIGIN = 'https://artifact.a2v';
// Local mirror for popular CDN files: asset-mirror/<host>/<path>. Served without touching the
// network, so common libraries (GSAP, fonts…) load instantly and renders don't depend on CDN uptime.
const mirrorDir = () => path.resolve(process.env.ASSET_MIRROR_DIR || fileURLToPath(new URL('../../asset-mirror', import.meta.url)));
const MIME = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
async function fromMirror(url) {
  try {
    const u = new URL(url);
    const root = mirrorDir();
    const file = path.resolve(root, u.hostname, '.' + decodeURIComponent(u.pathname));
    if (!file.startsWith(root + path.sep)) return null;
    const body = await fs.readFile(file);
    return { body, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  } catch { return null; }
}
const SAMPLE_RATE = 48000;
const AUTO_AUDIO_SECONDS = 180;

// One browser page per core, capped at 4 (leaves headroom for FFmpeg and the rest of the system).
export function defaultWorkers() {
  const n = os.cpus().length;
  return Math.max(1, Math.min(4, n));
}

function withTimeout(promise, ms, makeError) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(makeError()), ms); }),
  ]);
}

// ---------------------------------------------------------------- browser
let browserP = null;
let browserSource = null;
export const browserInfo = () => ({ source: browserSource });

// Which renderer does the capture browser use? (WebGL's unmasked renderer string, or software.)
export async function graphicsInfo() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'no WebGL (software rendering)';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
  } catch { return 'unknown'; } finally { await page.close().catch(() => {}); }
}
export function getBrowser() {
  if (!browserP) {
    const options = {
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Outbound proxy for artifact assets (CDNs, fonts), e.g. on locked-down hosts.
      proxy: process.env.BROWSER_PROXY ? { server: process.env.BROWSER_PROXY } : undefined,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--font-render-hinting=none',
        '--hide-scrollbars',
        '--mute-audio',
        // Never capture a half-drawn frame: finish rasterizing every tile before drawing, and don't
        // show blurry low-res tiles / placeholder squares for content still being decoded.
        '--run-all-compositor-stages-before-draw',
        '--disable-low-res-tiling',
        '--disable-checker-imaging',
        '--disable-partial-raster',
        // SwiftShader WebGL is ~6x slower for ordinary DOM/SVG artifacts, so it is opt-in.
        ...(process.env.ENABLE_WEBGL === '1' && process.env.ENABLE_GPU !== '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
        // Experimental: rasterize on the graphics card (headless Chromium uses the CPU by default).
        ...(process.env.ENABLE_GPU === '1' ? ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
          ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])] : []),
      ],
    };
    // BROWSER_FALLBACK_CHANNELS="msedge,chrome": if the bundled Chromium is missing, use an installed browser.
    const fallbacks = (process.env.BROWSER_FALLBACK_CHANNELS || '').split(',').map((c) => c.trim()).filter(Boolean);
    browserP = (async () => {
      try { const b = await chromium.launch(options); browserSource = options.executablePath ? 'custom' : 'bundled'; return b; }
      catch (e) {
        if (!/Executable doesn't exist|ENOENT|Failed to launch/i.test(e.message) || !fallbacks.length) throw e;
        for (const channel of fallbacks) {
          try { const b = await chromium.launch({ ...options, channel }); browserSource = channel; return b; } catch {}
        }
        throw e;
      }
    })();
    const mine = browserP;
    // Only forget the browser if it's still the current one (a relaunch may already have replaced it).
    mine.then((b) => b.on('disconnected', () => { if (browserP === mine) browserP = null; }), () => {});
    mine.catch(() => { if (browserP === mine) browserP = null; });
  }
  return browserP;
}
export async function closeBrowser() {
  const p = browserP;
  browserP = null;
  if (p) { try { await (await p).close(); } catch {} }
}

// ---------------------------------------------------------------- network guard (SSRF)
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
function makeGuard() {
  const cache = new Map();
  return async (url) => {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (process.env.ALLOW_PRIVATE_NETWORK === '1') return true;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!cache.has(host)) {
      cache.set(host, (async () => {
        if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
        if (net.isIP(host)) return !isPrivate(host);
        try { const r = await dns.lookup(host, { all: true }); return r.length > 0 && r.every((x) => !isPrivate(x.address)); }
        catch { return false; }
      })());
    }
    return cache.get(host);
  };
}

async function newPage(browser, html, { base, dsf, theme }, cfg, assetDir = null) {
  const context = await browser.newContext({
    viewport: { width: base.w, height: base.h },
    deviceScaleFactor: dsf,
    colorScheme: theme,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  const guard = makeGuard();
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/` || url === `${ORIGIN}/index.html`) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (url.startsWith(ORIGIN)) {
      // Desktop only: relative assets (./img.png) are served from the artifact's own folder.
      if (assetDir) {
        const root = path.resolve(assetDir);
        const file = path.resolve(root, '.' + decodeURIComponent(new URL(url).pathname));
        if (file.startsWith(root + path.sep)) {
          try { return route.fulfill({ status: 200, body: await fs.readFile(file), contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }); } catch {}
        }
      }
      return route.fulfill({ status: 404, body: '' });
    }
    const m = await fromMirror(url);
    if (m) return route.fulfill({ status: 200, body: m.body, contentType: m.contentType, headers: { 'access-control-allow-origin': '*' } });
    if (await guard(url)) return route.continue();
    return route.abort('blockedbyclient');
  });
  let page = null;
  context.on('page', (p) => { if (page && p !== page) p.close().catch(() => {}); }); // no popups
  await context.addInitScript(initScript, cfg);
  page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  return { context, page };
}

// ---------------------------------------------------------------- in-page helpers
// Reads <meta name="a2v:*"> hints, finds the start button and detects duration.
function pageProbe() {
  const meta = (n) => document.querySelector(`meta[name="a2v:${n}"]`)?.content?.trim() || '';
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      const i = Array.from(e.parentElement?.children || []).filter((c) => c.tagName === e.tagName).indexOf(e) + 1;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(' > ');
  };
  let start = meta('start') || null, startText = '';
  if (!start) {
    let best = null, bestScore = 0;
    document.querySelectorAll('button,[role=button],a,input[type=button],input[type=submit]').forEach((el) => {
      if (!vis(el)) return;
      const t = `${el.textContent} ${el.getAttribute('aria-label') || ''} ${el.id} ${el.className} ${el.value || ''}`.toLowerCase();
      if (!/(play|start|begin|watch|launch|enter|tap)/.test(t)) return;
      let s = 2;
      if (/(sound|audio)/.test(t)) s += 3;
      if (/(without|mute|silent|no sound|no audio)/.test(t)) s -= 4;
      const r = el.getBoundingClientRect();
      s += Math.min(2, (r.width * r.height) / 20000);
      if (el.closest('[role=group],[class*=control],[id*=control]')) s -= 1.5;
      if (s > bestScore) { bestScore = s; best = el; }
    });
    if (best && bestScore >= 2) { start = cssPath(best); startText = best.textContent.trim().slice(0, 60); }
  }
  let duration = null, durationSource = null;
  const md = parseFloat(meta('duration'));
  if (md > 0) { duration = md; durationSource = 'meta a2v:duration'; }
  if (!duration && typeof window.A2V_DURATION === 'number') { duration = window.A2V_DURATION; durationSource = 'window.A2V_DURATION'; }
  if (!duration && window.film && typeof window.film.duration === 'function') {
    const d = window.film.duration(); if (d > 0 && isFinite(d)) { duration = d; durationSource = 'GSAP timeline (window.film)'; }
  }
  if (!duration && window.gsap && gsap.globalTimeline) {
    let max = 0;
    try { gsap.globalTimeline.getChildren(false, true, true).forEach((c) => { const d = c.totalDuration(); if (isFinite(d) && d > max && d < 3600) max = d; }); } catch (e) {}
    if (max > 0) { duration = max; durationSource = 'GSAP global timeline'; }
  }
  // A length constant in the page's own script, as generated artifacts often have:
  // `const DUR = 30`, `const DURATION = 12.5`, `TOTAL_MS = 30000` (inline scripts only).
  if (!duration) {
    const re = /(?:\b(?:const|let|var)\s+|,\s*)(DUR|DURATION|TOTAL_DURATION|TOTAL_TIME|TOTAL_LENGTH|FILM_LENGTH|LENGTH|TOTAL|totalDuration|DUR_MS|DURATION_MS|TOTAL_MS)\s*=\s*(\d+(?:\.\d+)?)\s*(?=[,;\n]|$)/;
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = re.exec(s.textContent || '');
      if (!m) continue;
      let v = parseFloat(m[2]);
      if (/_MS$/.test(m[1]) || v >= 1000) v /= 1000;
      if (v >= 1 && v <= 600) { duration = v; durationSource = `script constant ${m[1]}`; break; }
    }
  }
  if (!duration) {
    let max = 0;
    try { document.getAnimations().forEach((a) => { const e = a.effect?.getComputedTiming?.().endTime; if (isFinite(e) && e > max) max = e; }); } catch (e) {}
    document.querySelectorAll('video,audio').forEach((m) => { if (isFinite(m.duration) && m.duration * 1000 > max) max = m.duration * 1000; });
    if (max > 0) { duration = max / 1000; durationSource = 'CSS / media'; }
  }
  const ctx = window.__a2v?.contexts?.() || { made: [], failed: [] };
  const webgl = ctx.made.some((k) => /webgl/i.test(k));
  const webglFailed = !webgl && ctx.failed.some((k) => /webgl/i.test(k));
  return { title: document.title || '', start, startText, duration, durationSource, hide: meta('hide'), webgl, webglFailed };
}

function hideChrome({ selectors, auto, startSel }) {
  const style = document.createElement('style');
  style.textContent = '[data-a2v-hide]{visibility:hidden!important;opacity:0!important;pointer-events:none!important}*{cursor:none!important}';
  document.head.appendChild(style);
  const mark = (el) => el && el.setAttribute('data-a2v-hide', '');
  selectors.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => { try { document.querySelectorAll(s).forEach(mark); } catch (e) {} });
  if (startSel) { try { document.querySelectorAll(startSel).forEach(mark); } catch (e) {} }
  if (!auto) return;
  const VA = innerWidth * innerHeight;
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  // Player bars: the largest small container around a range slider / media buttons.
  const seeds = document.querySelectorAll('input[type=range],[role=slider],[role=group][aria-label*=ontrol i],[aria-label*=ontrols i],[class*=controls],[id*=controls]');
  seeds.forEach((s) => {
    let top = s;
    for (let e = s.parentElement; e && e !== document.body && area(e) < VA * 0.3; e = e.parentElement) top = e;
    mark(top);
  });
}

// ---------------------------------------------------------------- probe
export async function probe(htmlPath, { theme = 'light', aspect = '16:9', poster = true, assetDir = null } = {}) {
  const html = await fs.readFile(htmlPath, 'utf8');
  const browser = await getBrowser();
  const base = ASPECTS[aspect] || ASPECTS['16:9'];
  const { context, page } = await newPage(browser, html, { base, dsf: 0.5, theme },
    { captureAudio: false, sampleRate: SAMPLE_RATE, audioSeconds: 1, trimSeconds: 1, freezeAtStart: false }, assetDir);
  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45000 });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.waitForTimeout(800);
    let info = await page.evaluate(pageProbe);
    if (info.start && poster) {
      // let "Preparing…" style buttons become ready so the UI can show their final label (UI probes only)
      await page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.disabled; }, info.start, { timeout: 15000 }).catch(() => {});
      info = await page.evaluate(pageProbe);
    }
    if (poster) {
      // Poster = a frame a little way into the animation (start button clicked, virtual clock).
      if (info.start) {
        const t = Math.min(2.5, (info.duration || 10) * 0.25);
        await page.evaluate(([sel, frame]) => {
          window.__a2v.freeze(); window.__a2v.startCapture();
          document.querySelector(sel)?.click();
          window.__a2v.goTo(30, frame);
        }, [info.start, Math.round(t * 30)]).catch(() => {});
        await page.evaluate(hideChrome, { selectors: info.hide || '', auto: true, startSel: info.start }).catch(() => {});
      }
      info.poster = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 72 })).toString('base64')}`;
    }
    return info;
  } finally { await context.close().catch(() => {}); }
}

// ---------------------------------------------------------------- single-frame preview
// Renders the artifact at one moment of its timeline (seconds), exactly as the video would show it:
// same start mode, same seeded clock, same hidden controls. Used to preview the poster frame.
// Sound is skipped (silent offline audio), which also makes "Preparing sound" buttons ready at once.
export async function previewFrame(htmlPath, { opts, info = {}, time = 0, assetDir = null, width = 960 } = {}) {
  const html = await fs.readFile(htmlPath, 'utf8');
  const browser = await getBrowser();
  const base = ASPECTS[opts.aspect] || ASPECTS['16:9'];
  const fps = opts.fps || 30;
  const startSel = opts.startSelector || info.start;
  const mode = opts.mode === 'auto' || !opts.mode ? (startSel ? 'click' : 'autoplay') : opts.mode;
  if (mode === 'click' && !startSel) throw new Error('No start button was found. Set a start selector.');
  const frame = Math.max(0, Math.round(time * fps));
  const cfg = { captureAudio: false, sampleRate: SAMPLE_RATE, audioSeconds: 1, trimSeconds: 1, seed: 0x5eed ^ html.length, fakeOfflineAudio: true };
  const { context, page } = await newPage(browser, html, { base, dsf: Math.min(1, width / base.w), theme: opts.theme }, cfg, assetDir);
  try {
    if (mode === 'autoplay') await page.addInitScript(() => { window.__a2v.freeze(); });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45000 });
    await withTimeout(page.evaluate(() => document.fonts.ready), 10000, () => new Error('fonts')).catch(() => {});
    if (mode === 'click') {
      const ok = await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      }, startSel, { timeout: 30000, polling: 200 }).then(() => true, () => false);
      if (!ok) throw new Error(`Start button "${startSel}" never became clickable.`);
      await page.waitForTimeout(300);
      await page.evaluate((sel) => { window.__a2v.freeze(); window.__a2v.startCapture(); document.querySelector(sel).click(); }, startSel);
    } else {
      await page.evaluate(() => { window.__a2v.freeze(); window.__a2v.startCapture(); });
    }
    await page.evaluate(hideChrome, {
      selectors: [opts.hideSelectors, info.hide].filter(Boolean).join(','),
      auto: opts.autoHideControls !== false,
      startSel: mode === 'click' ? startSel : '',
    });
    await withTimeout(page.evaluate(([f, n]) => window.__a2v.goTo(f, n), [fps, frame]), 60000,
      () => new Error('The artifact took too long to reach that moment.'));
    const shot = await page.screenshot({ type: 'jpeg', quality: 82 });
    return `data:image/jpeg;base64,${shot.toString('base64')}`;
  } finally { await context.close().catch(() => {}); }
}

// ---------------------------------------------------------------- render
export async function render({ htmlPath, outPath, workDir, opts, info: knownInfo, onProgress = () => {}, signal, assetDir = null, log = () => {} }) {
  const t0 = Date.now();
  const html = await fs.readFile(htmlPath, 'utf8');
  const size = outputSize(opts.resolution, opts.aspect);
  const step = (stage, extra = {}) => onProgress({ stage, elapsed: (Date.now() - t0) / 1000, ...extra });
  const ac = new AbortController(); // aborts all workers if the job is cancelled or one worker fails
  if (signal) signal.aborted ? ac.abort() : signal.addEventListener('abort', () => ac.abort(), { once: true });
  const check = () => { if (ac.signal.aborted) throw new Error(signal?.aborted ? 'cancelled' : 'aborted'); };

  step('probing');
  const info = knownInfo || await probe(htmlPath, { theme: opts.theme, aspect: opts.aspect, poster: false, assetDir });
  check();
  // Fail fast (with a readable reason) if FFmpeg can't run, instead of stalling at the first frame.
  const ff = await checkFfmpeg();
  log(`FFmpeg OK: ${ff.path}${ff.missing.length ? ` (missing encoders: ${ff.missing.join(', ')})` : ''}`);
  const need = { mp4: 'libx264', webm: 'libvpx-vp9', mov: 'prores_ks', gif: 'libx264' }[opts.format];
  if (ff.missing.includes(need)) throw new Error(`This FFmpeg build has no ${need} encoder, which ${opts.format.toUpperCase()} needs.`);
  const startSel = opts.startSelector || info.start;
  const mode = opts.mode === 'auto' ? (startSel ? 'click' : 'autoplay') : opts.mode;
  if (mode === 'click' && !startSel) throw new Error('Start mode is "click" but no start button was found. Set a start selector.');
  let duration = opts.duration === 'auto' ? info.duration : opts.duration;
  if (!duration) throw new Error('Could not detect the animation length. Set the duration manually.');
  duration = Math.min(duration, LIMITS.maxDuration);
  const fps = opts.fps;
  // Trim: capture only [trimStart, trimEnd) of the artifact's timeline. Workers still play from t=0
  // (fast-forward is cheap), so the animation state at the first captured frame is exact.
  const trimStart = Math.min(opts.trimStart || 0, Math.max(0, duration - 1 / fps));
  const trimEnd = opts.trimEnd === 'auto' || !opts.trimEnd ? duration : Math.min(duration, Math.max(trimStart + 1 / fps, opts.trimEnd));
  const startFrame = Math.round(trimStart * fps);
  const endFrame = Math.max(startFrame + 1, Math.round(trimEnd * fps));
  const frames = endFrame - startFrame; // frames to capture
  const clipStart = startFrame / fps, clipDuration = frames / fps;
  const hold = opts.hold || 0;
  const watermark = opts.watermark?.path ? opts.watermark : null;
  // Re-encode at the end only when something has to change the pixels or add frames.
  const post = opts.format === 'gif' || hold > 0 || opts.fadeIn || opts.fadeOut || !!watermark;

  // Split the timeline into contiguous frame ranges, one browser page each. Every page plays the
  // artifact from t=0 on the same deterministic virtual clock (seeded Math.random, identical steps),
  // fast-forwards without screenshots to its range, captures it, and the segments are concatenated.
  const maxWorkers = Math.max(1, +process.env.RENDER_WORKERS || defaultWorkers());
  const workers = Math.max(1, Math.min(maxWorkers, Math.floor(frames / 45)));
  const ranges = [];
  for (let k = 0; k < workers; k++) ranges.push([startFrame + Math.round((k * frames) / workers), startFrame + Math.round(((k + 1) * frames) / workers)]);
  step('loading', { duration, durationSource: opts.duration === 'auto' ? info.durationSource : 'manual', mode, frames, workers,
    trim: startFrame > 0 || endFrame < Math.round(duration * fps) ? [clipStart, endFrame / fps] : null });

  const content = info.webgl ? 'photo' : 'flat'; // encoder tuning, see videoArgs() in encode.js
  // PNG for WebGL too: JPEG blurs colour and grain, and the PNG cost is small next to a WebGL frame.
  const imageFormat = opts.quality === 'high' || opts.format === 'mov' || opts.format === 'gif' || info.webgl ? 'png' : 'jpeg';
  const ext = post ? 'mp4' : opts.format;
  const segFormat = post ? 'intermediate' : opts.format;
  const browser = await withTimeout(getBrowser(), 90000, () => new Error('The capture browser did not start within 90 s.'));
  log(`browser ready (${browser.version()}), ${workers} worker(s), ${frames} frames, mode=${mode}`);
  const counts = new Array(workers).fill(0);
  let loopStart = 0;
  let captureEnd = 0;
  const report = () => {
    const done = counts.reduce((a, b) => a + b, 0);
    if (!loopStart) loopStart = Date.now();
    const rate = done / Math.max(0.001, (Date.now() - loopStart) / 1000);
    step('capturing', { frame: done, frames, progress: done / frames, fps: rate, eta: rate > 0 ? (frames - done) / rate : null, workers });
  };
  const seed = 0x5eed ^ html.length;
  const audioOwner = workers - 1; // the last page plays through the whole timeline

  const capture = async (k) => {
    const [from, to] = ranges[k];
    const tag = `[worker ${k + 1}/${workers}]`;
    let stage = 'starting';
    const at = (st) => { stage = st; log(`${tag} ${st}`); };
    // Every step has a deadline, so a stuck page or encoder becomes a clear error instead of a hang.
    const within = (promise, ms, what) => withTimeout(promise, ms, () => new Error(`${what} (renderer ${k + 1}, step: ${stage}).`));
    // A custom track that replaces the artifact's sound means there's nothing to capture from the page.
    const replaced = !!opts.audio?.path && opts.audio.mix === 'replace';
    const wantAudio = !!opts.sound && opts.format !== 'gif' && k === audioOwner && !replaced;
    // With sound off, the artifact's own offline audio pre-render is skipped (instant, silent) in every
    // page: same result in all workers, and the start button is ready seconds sooner.
    const cfg = { captureAudio: wantAudio, sampleRate: SAMPLE_RATE, audioSeconds: wantAudio ? duration + 2 : 1, trimSeconds: endFrame / fps + hold, seed,
      fakeOfflineAudio: !opts.sound || opts.format === 'gif' || replaced };
    // Below 1080p we capture at 1x and let FFmpeg's lanczos downscale (faster than a scaled clip).
    // WebGL pages are the exception: they size their canvas by devicePixelRatio and their shaders cost
    // per pixel (on the CPU without a GPU), so they render at the output density (a 480p WebGL reel
    // draws 4.5× fewer pixels than at 1080p).
    const ctxDsf = info.webgl ? size.dsf : Math.max(1, size.dsf);
    at('opening page');
    const { context, page } = await within(newPage(browser, html, { base: size.base, dsf: ctxDsf, theme: opts.theme }, cfg, assetDir), 60000, 'The browser did not open a page');
    const segPath = path.join(workDir, `seg-${k}.${ext}`);
    let pipe = null;
    try {
      if (mode === 'autoplay') await page.addInitScript(() => { window.__a2v.freeze(); });
      at('loading artifact');
      await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60000 });
      at('waiting for fonts');
      await withTimeout(page.evaluate(() => document.fonts.ready), 10000, () => new Error('fonts')).catch(() => log(`${tag} fonts not ready after 10 s, continuing`));
      check();
      if (mode === 'click') {
        at(`waiting for start button ${startSel}`);
        // Wait for the start button to be clickable (e.g. "Preparing sound…" → "Play with sound").
        const ok = await page.waitForFunction((sel) => {
          const el = document.querySelector(sel);
          return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        }, startSel, { timeout: 60000, polling: 200 }).then(() => true, () => false);
        if (!ok) throw new Error(`Start button "${startSel}" never became clickable.`);
        await page.waitForTimeout(300);
        at('clicking start');
        await within(page.evaluate((sel) => { window.__a2v.freeze(); window.__a2v.startCapture(); document.querySelector(sel).click(); }, startSel), 30000, 'The artifact froze after clicking start');
      } else {
        await within(page.evaluate(() => { window.__a2v.freeze(); window.__a2v.startCapture(); }), 30000, 'The artifact did not respond');
      }
      await within(page.evaluate(hideChrome, {
        selectors: [opts.hideSelectors, info.hide].filter(Boolean).join(','),
        auto: opts.autoHideControls,
        startSel: mode === 'click' ? startSel : '',
      }), 30000, 'The artifact did not respond');
      const cdp = await context.newCDPSession(page);
      // Fast-forward (no screenshots) to this worker's first frame.
      if (from > 0) {
        // In chunks, each with its own deadline. WebGL pages queue their drawing on the (software)
        // GPU without waiting for it, so skipped frames pile up and the first real frame then waits for
        // all of them; a throwaway screenshot after each chunk drains that queue as we go.
        const chunk = info.webgl ? 10 : from;
        for (let done = -1; done < from - 1;) {
          const next = Math.min(from - 1, done + chunk);
          at(`fast-forwarding to frame ${from} (${next + 1}/${from})`);
          await within(page.evaluate(([f, n]) => window.__a2v.goTo(f, n), [fps, next]), 180000, 'Fast-forwarding the animation took too long');
          if (info.webgl) await within(cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 10, optimizeForSpeed: true }), 180000, 'Fast-forwarding the animation took too long');
          done = next;
          check();
        }
      }
      check();

      at('starting FFmpeg');
      pipe = startFramePipe({ fps, format: segFormat, quality: opts.quality, imageFormat, out: segPath,
        width: size.width, height: size.height, signal: ac.signal, content });
      const shot = { format: imageFormat, optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true };
      // CDP screenshots come back at CSS-pixel size (1920×1080) whatever deviceScaleFactor is; the
      // density has to be requested explicitly with clip.scale, or 1440p / 4K renders are upscaled 1080p.
      if (ctxDsf !== 1) shot.clip = { x: 0, y: 0, width: size.base.w, height: size.base.h, scale: ctxDsf };
      if (imageFormat === 'jpeg') shot.quality = 94;
      at(`capturing frames ${from}–${to - 1}`);
      // Pipelined: frame i is handed to FFmpeg while the browser already renders frame i+1.
      let pending = Promise.resolve();
      for (let i = from; i < to; i++) {
        check();
        stage = `frame ${i}`;
        await within(page.evaluate(([f, n]) => window.__a2v.goTo(f, n), [fps, i]), 60000, `The artifact stopped responding at frame ${i}`);
        const { data } = await within(cdp.send('Page.captureScreenshot', shot), 60000, `Taking the screenshot of frame ${i} timed out`);
        await within(pending, 120000, `FFmpeg stopped accepting frames at frame ${i - 1}`);
        pending = pipe.write(Buffer.from(data, 'base64'));
        pending.catch(() => {});
        counts[k]++;
        if (counts[k] === 1 || counts[k] % 3 === 0) report();
      }
      await within(pending, 120000, `FFmpeg stopped accepting frames at frame ${to - 1}`);
      at('closing FFmpeg');
      await within(pipe.end(), 300000, 'FFmpeg did not finish the segment');
      pipe = null;

      let audio = null;
      if (wantAudio) {
        at('rendering soundtrack');
        // keep the soundtrack running under the held last frame, then flush the final events
        await page.evaluate(([f, n]) => window.__a2v.goTo(f, n), [fps, endFrame + Math.round(hold * fps)]);
        audio = await within(collectAudio(page, workDir, duration), 300000, 'Rendering the soundtrack took too long');
      }
      at('done');
      return { segPath, audio };
    } catch (e) {
      log(`${tag} failed at "${stage}": ${e.message}`);
      throw e;
    } finally {
      if (pipe) pipe.end().catch(() => {});
      await context.close().catch(() => {});
    }
  };

  const results = await Promise.all(ranges.map((_, k) => capture(k).catch((e) => { ac.abort(); throw e; })));
  captureEnd = Date.now();
  report();
  check();

  step('encoding', { progress: 1 });
  const videoTmp = path.join(workDir, `video.${ext}`);
  if (results.length === 1) await fs.rename(results[0].segPath, videoTmp);
  else {
    const list = path.join(workDir, 'segments.txt');
    await fs.writeFile(list, results.map((r) => `file '${r.segPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', videoTmp], { signal });
  }
  const audio = results[audioOwner].audio || { wavPath: null, tracks: [], info: { source: opts.sound ? 'none detected' : 'off' } };
  const customAudio = opts.sound && opts.format !== 'gif' && opts.audio?.path ? opts.audio : null;
  if (customAudio) {
    const name = opts.audio.name || path.basename(opts.audio.path);
    audio.info = customAudio.mix === 'replace' ? { source: 'custom track', track: name }
      : { source: `custom track + ${audio.info.source}`, track: name };
  }

  step('finalizing');
  await finalize({ format: opts.format, quality: opts.quality, videoPath: videoTmp, wavPath: audio.wavPath, tracks: audio.tracks,
    clipStart, clipDuration, hold, fadeIn: opts.fadeIn, fadeOut: opts.fadeOut, fadeDuration: opts.fadeDuration, watermark, customAudio, content,
    out: outPath, width: size.width, height: size.height, fps, post, signal });
  const total = clipDuration + hold;

  // Poster: a PNG of one frame (default: middle of the clip). GIFs are decoded from the clean
  // intermediate instead of the 256-colour GIF; videos from the final file (watermark included).
  let posterPath = null;
  if (opts.poster) {
    step('poster');
    const t = Math.min(opts.posterTime === 'auto' ? clipDuration / 2 : opts.posterTime, total - 1 / fps);
    posterPath = opts.posterOut || outPath.replace(/\.[^.\\/]+$/, '') + '.png';
    await extractPoster({ videoPath: opts.format === 'gif' ? videoTmp : outPath, time: opts.format === 'gif' ? Math.min(t, clipDuration - 1 / fps) : t, out: posterPath, signal });
  }
  const stat = await fs.stat(outPath);
  return {
    title: info.title, duration: total, frames, fps, width: size.width, height: size.height, workers,
    clip: [clipStart, endFrame / fps], hold, fades: [!!opts.fadeIn, !!opts.fadeOut], watermark: !!watermark, poster: posterPath,
    mode, startSelector: mode === 'click' ? startSel : null, durationSource: opts.duration === 'auto' ? info.durationSource : 'manual',
    audio: audio.info, webgl: !!info.webgl, bytes: stat.size, seconds: (Date.now() - t0) / 1000,
    captureFps: loopStart ? +(frames / Math.max(0.001, (captureEnd - loopStart) / 1000)).toFixed(1) : null,
    gpu: process.env.ENABLE_GPU === '1',
  };
}

async function collectAudio(page, workDir, duration) {
  let wavPath = null;
  const tracks = [];
  let info = { source: 'none detected' };
  const a = await page.evaluate(() => window.__a2v.renderAudio());
  if (a && !a.silent) {
    wavPath = path.join(workDir, 'audio.wav');
    const fh = await fs.open(wavPath, 'w');
    await fh.write(wavHeader(a.frames * 4, a.sampleRate));
    for (let c = 0; c < a.chunks; c++) {
      const b64 = await page.evaluate((k) => window.__a2vAudioChunks[k], c);
      await fh.write(Buffer.from(b64, 'base64'));
    }
    await fh.close();
    info = { source: 'Web Audio', peak: +a.peak.toFixed(3) };
  }
  const media = await page.evaluate(() => window.__a2v.media());
  for (const [k, m] of media.entries()) {
    if (!m.src || m.volume === 0 || m.at >= duration) continue;
    const b64 = await page.evaluate(async (src) => {
      try {
        const r = await fetch(src); const b = await r.blob(); if (b.size > 50e6) return null;
        return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(b); });
      } catch (e) { return null; }
    }, m.src);
    if (!b64) continue;
    const p = path.join(workDir, `media-${k}`);
    await fs.writeFile(p, Buffer.from(b64, 'base64'));
    tracks.push({ path: p, at: m.at, offset: m.offset, end: m.end ?? null, volume: m.volume, loop: m.loop });
  }
  if (tracks.length) info = { ...info, source: info.source === 'Web Audio' ? 'Web Audio + media' : 'media elements', mediaTracks: tracks.length };
  return { wavPath, tracks, info };
}
