// Artifact to Video — Electron main process.
// Runs the shared render engine (Playwright + bundled headless Chromium + FFmpeg) in-process and
// talks to the window over a small IPC API exposed by preload.cjs.
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isDev = !app.isPackaged;

if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------------ log file (userData/logs/main.log)
let logFile = null;
function setupLog() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fss.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'main.log');
  try { if (fss.statSync(logFile).size > 2e6) fss.renameSync(logFile, path.join(dir, 'main.old.log')); } catch {}
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    try { fss.appendFileSync(logFile, line); } catch {}
  };
  for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[name].bind(console);
    console[name] = (...a) => { write(level, a); orig(...a); };
  }
  process.on('uncaughtException', (e) => console.error('uncaught', e));
  process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
  console.log(`---- Artifact to Video ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${os.release()} · ${os.cpus().length} CPUs · ${Math.round(os.totalmem() / 1e9)} GB RAM`);
}

// ------------------------------------------------------------------ environment for the engine
function configureEngineEnv(settings) {
  // Bundled headless Chromium (resources/browsers) in the installed app; Playwright's default cache in dev.
  const bundled = path.join(process.resourcesPath, 'browsers');
  const local = path.join(__dirname, 'browsers');
  if (!isDev && fss.existsSync(bundled)) process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
  else if (fss.existsSync(local)) process.env.PLAYWRIGHT_BROWSERS_PATH = local;

  // FFmpeg: ffmpeg-static binary (unpacked from the asar), falling back to ffmpeg on PATH.
  if (!process.env.FFMPEG_PATH) {
    try {
      const p = require('ffmpeg-static');
      const real = p && p.replace('app.asar', 'app.asar.unpacked');
      if (real && fss.existsSync(real)) process.env.FFMPEG_PATH = real;
    } catch {}
  }
  process.env.BROWSER_FALLBACK_CHANNELS = 'msedge,chrome'; // if the bundled Chromium is missing or damaged
  process.env.ASSET_MIRROR_DIR = path.join(__dirname, 'asset-mirror');
  process.env.MAX_DURATION = String(settings.maxDuration || 1800);
  process.env.QUEUE_MAX = '1000';
  process.env.JOB_TIMEOUT_MIN = '240';
  process.env.RENDER_WORKERS = String(settings.renderWorkers);
  process.env.ALLOW_PRIVATE_NETWORK = settings.allowLocalNetwork ? '1' : '0';
  process.env.ENABLE_GPU = settings.useGpu ? '1' : '0';
  const bp = process.env.PLAYWRIGHT_BROWSERS_PATH;
  console.log(`browsers: ${bp || '(Playwright default cache)'}${bp ? ` [${fss.existsSync(bp) ? fss.readdirSync(bp).join(', ') : 'MISSING'}]` : ''}`);
  console.log(`ffmpeg: ${process.env.FFMPEG_PATH || '(ffmpeg on PATH)'}${process.env.FFMPEG_PATH ? (fss.existsSync(process.env.FFMPEG_PATH) ? '' : ' [MISSING]') : ''}`);
  console.log(`workers: ${settings.renderWorkers}, output: ${settings.outputDir}`);
}

// ------------------------------------------------------------------ settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = () => ({
  outputDir: path.join(app.getPath('videos'), 'Artifact to Video'),
  renderWorkers: Math.max(1, Math.min(4, os.cpus().length)),
  useGpu: false,
  watermarkPath: null,
  settingsVersion: 3,
  openFolderWhenDone: false,
  notify: true,
  allowLocalNetwork: false,
  options: null,
  audioFiles: [], // soundtrack library: [{ id, path, name, duration }]
});
let settings = defaultSettings();
async function loadSettings() {
  try { settings = { ...defaultSettings(), ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) }; } catch {}
  // v3: worker default is min(4, cores); re-apply it once to settings saved by older versions.
  if ((settings.settingsVersion || 1) < 3) { settings.renderWorkers = defaultSettings().renderWorkers; settings.settingsVersion = 3; }
}
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

// ------------------------------------------------------------------ engine (loaded after env is set)
let engine = null; // { probe, closeBrowser, presets, queue }
async function loadEngine() {
  configureEngineEnv(settings);
  const renderer = await import('./engine/render/renderer.js');
  const presets = await import('./engine/render/presets.js');
  const { JobQueue } = await import('./engine/jobs.js');
  const work = path.join(app.getPath('temp'), 'artifact-to-video');
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(work, 'jobs'), { recursive: true });
  const queue = new JobQueue(work, { exposePaths: true });
  queue.on('update', onJobUpdate);
  queue.on('log', ({ id, msg }) => console.log(`[job ${id}] ${msg}`));
  const encode = await import('./engine/render/encode.js');
  engine = { ...renderer, presets, queue, checkFfmpeg: encode.checkFfmpeg, probeAudio: encode.probeAudio };
  runSystemCheck();
}

// Startup self-test: can FFmpeg run, can the capture browser start? Shown in App settings.
let systemCheck = { pending: true };
async function runSystemCheck() {
  systemCheck = { pending: true };
  const [ff, br] = await Promise.allSettled([
    engine.checkFfmpeg(),
    engine.getBrowser().then(async (b) => ({ version: b.version(), source: engine.browserInfo().source, graphics: await engine.graphicsInfo(), gpu: settings.useGpu })),
  ]);
  systemCheck = {
    ffmpeg: ff.status === 'fulfilled' ? { ok: true, path: ff.value.path, missing: ff.value.missing } : { ok: false, error: ff.reason.message },
    browser: br.status === 'fulfilled' ? { ok: true, ...br.value } : { ok: false, error: String(br.reason.message).split('\n')[0] },
    logFile,
  };
  console.log('system check', JSON.stringify(systemCheck));
  send('system-check', systemCheck);
}

// ------------------------------------------------------------------ window
let win = null;
// One combined title bar: the app header doubles as the window's title bar, and Windows draws its
// own minimize / maximize / close buttons on top of it (titleBarOverlay). Colors follow the theme.
const HEADER_H = 56; // keep in sync with body.desktop .top in ui/app.css
const overlay = () => nativeTheme.shouldUseDarkColors
  ? { color: '#1C1F26', symbolColor: '#E6E9EE', height: HEADER_H } // --panel / --ink in ui/base.css
  : { color: '#FAFBFC', symbolColor: '#161A21', height: HEADER_H };
nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay?.(overlay()); });

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 980, minHeight: 640,
    title: 'Artifact to Video',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161B' : '#E8EBEE', // --bg in ui/base.css
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Right-click menu: the packaged app has no menu bar, so this is how people copy text
  // (labels, file paths, error messages) and use cut / copy / paste in the input fields.
  win.webContents.on('context-menu', (e, p) => {
    const f = p.editFlags || {};
    const items = p.isEditable
      ? [{ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' },
         { role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste },
         { type: 'separator' }, { role: 'selectAll' }]
      : [{ role: 'copy', enabled: !!p.selectionText.trim() }, { role: 'selectAll' }];
    if (isDev) items.push({ type: 'separator' }, { label: 'Inspect element', click: () => win.webContents.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('closed', () => { win = null; });
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// ------------------------------------------------------------------ items (opened artifacts)
const items = new Map(); // id -> { id, path, name, info, size, status }
let itemSeq = 1;

async function addFiles(paths) {
  const added = [];
  for (const p of paths) {
    if (!/\.html?$/i.test(p)) continue;
    const id = `i${itemSeq++}`;
    const stat = await fs.stat(p).catch(() => null);
    if (!stat?.isFile()) continue;
    const item = { id, path: p, name: path.basename(p), size: stat.size, info: null, status: 'probing' };
    items.set(id, item);
    send('item', item);
    added.push(item);
  }
  // probe one at a time (each opens a browser page)
  for (const item of added) {
    try {
      item.info = await engine.probe(item.path, { aspect: '16:9', theme: 'light', assetDir: path.dirname(item.path) });
      item.info.aspect = '16:9'; item.info.theme = 'light';
      item.status = 'ready';
    } catch (e) {
      item.status = 'invalid';
      item.error = `Could not open: ${String(e.message).split('\n')[0]}`;
    }
    send('item', item);
  }
  return added.map((i) => i.id);
}

// ------------------------------------------------------------------ jobs
const slug = (s) => (s || 'artifact').toLowerCase().replace(/\|.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'artifact';
function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fss.existsSync(p) || reserved.has(p); n++) p = path.join(dir, `${base} (${n}).${ext}`);
  reserved.add(p);
  return p;
}
const reserved = new Set();
const jobItem = new Map(); // jobId -> itemId

function onJobUpdate(job) {
  const itemId = jobItem.get(job.id);
  if (!itemId) return;
  const item = items.get(itemId);
  if (!item) return;
  item.status = job.status === 'done' ? 'done' : job.status;
  item.job = job;
  send('item', item);
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    reserved.delete(job.outPath);
    if (job.opts?.posterOut) reserved.delete(job.opts.posterOut);
    console.log(`[job ${job.id}] ${job.status}${job.error ? `: ${job.error}` : ''}${job.result ? ` (${job.result.frames} frames, ${job.result.seconds.toFixed(1)} s)` : ''}`);
    if (job.status === 'done') {
      console.log(`[job ${job.id}] capture speed ${job.result.captureFps} frames/s with ${job.result.workers} worker(s)${job.result.gpu ? ', GPU on' : ''}`);
      if (settings.notify && Notification.isSupported() && !win?.isFocused()) {
        const n = new Notification({ title: 'Video ready', body: `${path.basename(job.outPath)} · ${(job.result.bytes / 1e6).toFixed(1)} MB`, silent: false });
        n.on('click', () => shell.showItemInFolder(job.outPath));
        n.show();
      }
      if (settings.openFolderWhenDone && !hasActive()) shell.showItemInFolder(job.outPath);
    }
  }
  updateTaskbar();
}
const hasActive = () => [...engine.queue.jobs.values()].some((j) => ['queued', 'running'].includes(j.status));
function updateTaskbar() {
  if (!win || win.isDestroyed()) return;
  const jobs = [...engine.queue.jobs.values()].filter((j) => jobItem.has(j.id) && j.batch === batchNo);
  const active = jobs.some((j) => ['queued', 'running'].includes(j.status));
  if (!active) { win.setProgressBar(-1); return; }
  const prog = (j) => (j.status === 'done' ? 1 : j.status === 'running' ? ({ capturing: (j.progress?.progress || 0) * 0.92, encoding: 0.94, audio: 0.96, finalizing: 0.98 }[j.progress?.stage] ?? 0) : 0);
  win.setProgressBar(jobs.reduce((a, j) => a + prog(j), 0) / jobs.length);
}
let batchNo = 0;

// ------------------------------------------------------------------ watermark image
function watermarkInfo() {
  const p = settings.watermarkPath;
  if (!p || !fss.existsSync(p)) return null;
  const img = nativeImage.createFromPath(p);
  const thumb = img.isEmpty() ? null : img.resize({ width: Math.min(320, img.getSize().width) }).toDataURL(); // sharp at 2× in the 112 px preview
  return { name: path.basename(p), thumb };
}

// ------------------------------------------------------------------ soundtrack library
// The window only ever sees { id, name, duration }; paths stay here and are resolved at convert time.
const audioLibrary = () => (settings.audioFiles || []).map(({ id, name, duration }) => ({ id, name, duration }));
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'webm'];

// ------------------------------------------------------------------ IPC
function ipc() {
  ipcMain.handle('pick-audio', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add audio files', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTS }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const added = [], errors = [];
    settings.audioFiles ||= [];
    for (const p of r.filePaths) {
      const known = settings.audioFiles.find((a) => a.path === p);
      if (known) { added.push(known.id); continue; } // already in the list: just select it
      try {
        const { duration } = await engine.probeAudio(p);
        const id = `au${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        settings.audioFiles.push({ id, path: p, name: path.basename(p), duration });
        added.push(id);
      } catch (e) { errors.push(`${path.basename(p)}: ${e.message}`); }
    }
    await saveSettings();
    return { library: audioLibrary(), added, errors };
  });
  ipcMain.handle('remove-audio', async (e, id) => {
    settings.audioFiles = (settings.audioFiles || []).filter((a) => a.id !== String(id));
    await saveSettings();
    return audioLibrary();
  });

  ipcMain.handle('pick-watermark', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a logo / watermark image', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return watermarkInfo();
    settings.watermarkPath = r.filePaths[0];
    await saveSettings();
    return watermarkInfo();
  });

  ipcMain.handle('init', () => ({
    presets: {
      formats: Object.entries(engine.presets.FORMATS).map(([id, f]) => ({ id, label: f.label, codec: f.codec, audio: f.audio })),
      presets: engine.presets.PRESETS, presetFields: engine.presets.PRESET_FIELDS,
      resolutions: Object.keys(engine.presets.RESOLUTIONS),
      aspects: Object.keys(engine.presets.ASPECTS), fps: engine.presets.FPS,
      limits: { ...engine.presets.LIMITS },
    },
    settings, cpus: os.cpus().length, version: app.getVersion(), platform: process.platform, watermark: watermarkInfo(), audioFiles: audioLibrary(),
    // System check details (FFmpeg, browser, graphics) are for debugging: shown in dev (`npm start`),
    // or in the installed app when started with A2V_DEBUG=1. Failures still show as an error banner.
    debug: isDev || process.env.A2V_DEBUG === '1',
    items: [...items.values()],
  }));

  // Poster preview: one frame of an opened artifact at `time` seconds into its animation.
  ipcMain.handle('preview-frame', async (e, { id, time, options }) => {
    const item = items.get(String(id));
    if (!item || !item.info) throw new Error('That artifact is no longer in the list.');
    const opts = engine.presets.normalizeOptions(options || {});
    return engine.previewFrame(item.path, { opts, info: item.info, time: Math.max(0, +time || 0), assetDir: path.dirname(item.path) });
  });

  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add HTML artifacts', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'HTML artifacts', extensions: ['html', 'htm'] }],
    });
    return r.canceled ? [] : addFiles(r.filePaths);
  });
  ipcMain.handle('add-files', (e, paths) => addFiles(Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle('remove-item', (e, id) => {
    const item = items.get(id);
    if (item?.job && ['queued', 'running'].includes(item.job.status)) return false;
    items.delete(id);
    return true;
  });
  ipcMain.handle('clear-finished', () => {
    for (const [id, it] of items) if (['done', 'error', 'cancelled', 'invalid'].includes(it.status)) items.delete(id);
    return [...items.values()];
  });

  // options = shared settings; perItem = { [itemId]: { trimStart, trimEnd, posterTime, audio } } for artifacts
  // that have their own trim / poster frame / soundtrack (only those keys are taken from it).
  // A soundtrack is chosen by library id; its path is looked up here, never taken from the window.
  ipcMain.handle('convert', async (e, { ids, options, perItem = {} }) => {
    const optsFor = (id) => {
      const own = perItem?.[id] || {};
      const o = engine.presets.normalizeOptions({ ...(options || {}),
        ...Object.fromEntries(['trimStart', 'trimEnd', 'posterTime', 'audio'].filter((k) => k in own).map((k) => [k, own[k]])) });
      if (o.watermark) o.watermark.path = settings.watermarkPath;
      if (o.audio) {
        const a = (settings.audioFiles || []).find((f) => f.id === o.audio.track);
        if (!a) throw new Error('The chosen audio file is no longer in the list. Pick the soundtrack again.');
        if (!fss.existsSync(a.path)) throw new Error(`The audio file ${a.name} was moved or deleted. Remove it from the list and add it again.`);
        Object.assign(o.audio, { path: a.path, name: a.name });
      }
      return o;
    };
    const opts = optsFor(null);
    for (const id of ids) optsFor(id); // a missing soundtrack fails before anything starts
    if (opts.watermark && (!settings.watermarkPath || !fss.existsSync(settings.watermarkPath))) throw new Error('The watermark image is missing. Choose it again.');
    settings.options = options; saveSettings().catch(() => {});
    await fs.mkdir(settings.outputDir, { recursive: true });
    batchNo++;
    const started = [];
    for (const id of ids) {
      const item = items.get(id);
      if (!item || item.status === 'probing' || item.status === 'invalid') continue;
      if (item.job && ['queued', 'running'].includes(item.job.status)) continue;
      const itemOpts = optsFor(id);
      const ext = engine.presets.FORMATS[opts.format].ext;
      const base = `${slug(item.info?.title || item.name.replace(/\.html?$/i, ''))}-${opts.resolution}-${opts.fps}fps`;
      const out = uniquePath(settings.outputDir, base, ext);
      const jobOpts = { ...itemOpts, posterOut: opts.poster ? uniquePath(settings.outputDir, path.basename(out).replace(/\.[^.]+$/, ''), 'png') : undefined };
      const job = engine.queue.create({
        upload: { id: item.id, path: item.path, name: item.name, info: item.info },
        opts: jobOpts, owner: 'desktop', outPath: out, assetDir: path.dirname(item.path),
      });
      job.batch = batchNo;
      jobItem.set(job.id, item.id);
      item.job = engine.queue.public(job);
      item.status = job.status;
      send('item', item);
      started.push(job.id);
    }
    updateTaskbar();
    return started;
  });

  ipcMain.handle('cancel', (e, id) => {
    const item = items.get(id);
    const job = item?.job && engine.queue.get(item.job.id);
    if (job) engine.queue.cancel(job);
    return true;
  });
  ipcMain.handle('cancel-all', () => { for (const j of engine.queue.jobs.values()) if (['queued', 'running'].includes(j.status)) engine.queue.cancel(j); return true; });

  ipcMain.handle('system-check', () => systemCheck);
  ipcMain.handle('rerun-system-check', () => { runSystemCheck(); return { pending: true }; });
  ipcMain.handle('open-log', () => (logFile ? shell.openPath(logFile) : 'no log'));
  ipcMain.handle('reveal', (e, p) => { if (p && fss.existsSync(p)) shell.showItemInFolder(p); });
  ipcMain.handle('open-path', (e, p) => (p && fss.existsSync(p) ? shell.openPath(p) : 'missing'));
  ipcMain.handle('open-output-dir', async () => { await fs.mkdir(settings.outputDir, { recursive: true }); return shell.openPath(settings.outputDir); });

  ipcMain.handle('choose-output-dir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Save videos to…', defaultPath: settings.outputDir, properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) { settings.outputDir = r.filePaths[0]; await saveSettings(); }
    return settings;
  });
  ipcMain.handle('set-settings', async (e, patch) => {
    const allowed = ['renderWorkers', 'openFolderWhenDone', 'notify', 'allowLocalNetwork', 'useGpu'];
    const gpuBefore = settings.useGpu;
    for (const k of allowed) if (k in (patch || {})) settings[k] = patch[k];
    settings.renderWorkers = Math.max(1, Math.min(os.cpus().length, +settings.renderWorkers || 1));
    process.env.RENDER_WORKERS = String(settings.renderWorkers);
    process.env.ALLOW_PRIVATE_NETWORK = settings.allowLocalNetwork ? '1' : '0';
    process.env.ENABLE_GPU = settings.useGpu ? '1' : '0';
    if (gpuBefore !== settings.useGpu && !hasActive()) { await engine.closeBrowser(); runSystemCheck(); } // relaunch the capture browser
    await saveSettings();
    return settings;
  });
}

// ------------------------------------------------------------------ app lifecycle
const filesFromArgv = (argv) => argv.slice(isDev ? 2 : 1).filter((a) => /\.html?$/i.test(a) && fss.existsSync(a));

app.on('second-instance', (e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const files = filesFromArgv(argv);
  if (files.length && engine) addFiles(files);
});

app.whenReady().then(async () => {
  setupLog();
  Menu.setApplicationMenu(isDev ? Menu.getApplicationMenu() : null);
  await loadSettings();
  await loadEngine();
  ipc();
  createWindow();
  const files = filesFromArgv(process.argv);
  if (files.length) win.webContents.once('did-finish-load', () => addFiles(files));
  // test hook: A2V_SMOKE=<html> <out-dir> converts one file headlessly and quits
  if (process.env.A2V_SMOKE) smoke().catch((e) => { console.error(e); app.exit(1); });
});

app.on('window-all-closed', async () => {
  if (engine) { for (const j of engine.queue.jobs.values()) if (['queued', 'running'].includes(j.status)) engine.queue.cancel(j); await engine.closeBrowser(); }
  app.quit();
});

async function smoke() {
  // A2V_SMOKE="a.html;b.html|<outDir>|{options json}" — converts through the real UI and quits.
  const [fileList, outDir, ...rest] = process.env.A2V_SMOKE.split('|');
  settings.outputDir = outDir;
  const opts = JSON.parse(rest.join('|') || '{}');
  const shot = async (name) => fs.writeFile(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await new Promise((r) => setTimeout(r, 1000));
  const ids = await addFiles(fileList.split(';'));
  for (const id of ids) console.log('[smoke] probed', items.get(id).name, items.get(id).status, items.get(id).info?.duration, items.get(id).info?.start);
  if (process.env.A2V_SMOKE_WM) { // optional watermark for the smoke test
    settings.watermarkPath = process.env.A2V_SMOKE_WM;
    await win.webContents.executeJavaScript(`window.__a2vTest.setWatermark(${JSON.stringify(watermarkInfo())})`);
  }
  if (process.env.A2V_SMOKE_AUDIO) { // optional: audio files ("a.mp3;b.m4a") added to the soundtrack list
    settings.audioFiles = [];
    for (const p of process.env.A2V_SMOKE_AUDIO.split(';')) {
      const { duration } = await engine.probeAudio(p);
      settings.audioFiles.push({ id: `smoke${settings.audioFiles.length + 1}`, path: p, name: path.basename(p), duration });
    }
    await win.webContents.executeJavaScript(`window.__a2vTest.setAudioLibrary(${JSON.stringify(audioLibrary())})`);
  }
  if (Object.keys(opts).length) await win.webContents.executeJavaScript(`window.__applyOptions(${JSON.stringify(opts)})`);
  await new Promise((r) => setTimeout(r, 600));
  if (process.env.A2V_SMOKE_JS) { // optional: run a UI script (a file path) before converting, e.g. to select rows
    const r = await win.webContents.executeJavaScript(fss.readFileSync(process.env.A2V_SMOKE_JS, 'utf8'));
    console.log('[smoke] script', JSON.stringify(r));
  }
  if (opts.poster) { // open the Poster panel and wait for the frame preview
    const ok = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#posterBox').open = true;
      for (let i = 0; i < 240 && document.querySelector('.pp-img').hidden; i++) await new Promise((r) => setTimeout(r, 250));
      document.querySelector('.form-scroll').scrollTop = document.querySelector('#posterBox').offsetTop - 40;
      return !document.querySelector('.pp-img').hidden || document.querySelector('.pp-msg').textContent;
    })()`);
    console.log('[smoke] poster preview', ok);
  }
  await shot('ui-ready.png');
  await win.webContents.executeJavaScript('document.querySelector("#convert").click()');
  let shotTaken = false;
  await new Promise((resolve) => {
    const t = setInterval(async () => {
      const list = ids.map((id) => items.get(id));
      if (!shotTaken && list.some((it) => it.job?.progress?.stage === 'capturing' && it.job.progress.frame > 30)) { shotTaken = true; await shot('ui-progress.png'); }
      if (list.every((it) => ['done', 'error', 'cancelled'].includes(it.status))) { clearInterval(t); resolve(); }
    }, 500);
  });
  await new Promise((r) => setTimeout(r, 1000));
  await shot('ui-done.png');
  for (const id of ids) { const it = items.get(id); console.log('[smoke] result', it.name, it.status, it.job?.error || '', it.job?.outPath, JSON.stringify(it.job?.result?.audio)); }
  app.quit();
}
