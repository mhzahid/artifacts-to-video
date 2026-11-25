import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobQueue } from './jobs.js';
import { probe, previewFrame, getBrowser, closeBrowser } from './render/renderer.js';
import { probeAudio } from './render/encode.js';
import { FORMATS, RESOLUTIONS, ASPECTS, FPS, QUALITIES, LIMITS, PRESETS, PRESET_FIELDS, normalizeOptions, outputSize } from './render/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, 'storage'));
const PORT = +process.env.PORT || 3000;
const MAX_UPLOAD_MB = +process.env.MAX_UPLOAD_MB || 25;
const TTL = (+process.env.JOB_TTL_MIN || 60) * 60_000;
const MAX_AUDIO_MB = +process.env.MAX_AUDIO_MB || 30;

await fs.mkdir(path.join(STORAGE, 'uploads'), { recursive: true });
await fs.mkdir(path.join(STORAGE, 'jobs'), { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const queue = new JobQueue(STORAGE);
const uploads = new Map(); // id -> { id, name, path, info, createdAt, owner }

// Each browser gets an anonymous owner id (cookie) so people only see / control their own jobs.
app.use((req, res, next) => {
  const m = /(?:^|;\s*)a2v_owner=([\w-]{16,40})/.exec(req.headers.cookie || '');
  req.owner = m ? m[1] : crypto.randomBytes(12).toString('base64url');
  if (!m) res.setHeader('Set-Cookie', `a2v_owner=${req.owner}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
  next();
});

const watermarks = new Map(); // id -> { path, owner, createdAt }
const wmUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
// Accept only real PNG / JPEG / WebP images (checked by their first bytes, not the file name).
function imageType(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Soundtracks: stored on disk under a random name, then checked by FFmpeg itself (probeAudio),
// so only files with a real audio stream are kept.
const audios = new Map(); // id -> { path, name, duration, owner, createdAt }
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)$/i;
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(STORAGE, 'uploads'),
    filename: (req, file, cb) => cb(null, `au-${crypto.randomBytes(9).toString('base64url')}${(AUDIO_EXT.exec(file.originalname)?.[0] || '.bin').toLowerCase()}`),
  }),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, AUDIO_EXT.test(file.originalname) || /^audio\//.test(file.mimetype)),
});

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(STORAGE, 'uploads'),
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(9).toString('base64url')}.html`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /\.html?$/i.test(file.originalname) || file.mimetype === 'text/html'),
});

const limiter = (max, windowMin) => rateLimit({ windowMs: windowMin * 60_000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, slow down a little.' } });

// ------------------------------------------------------------------ API
app.get('/api/presets', (req, res) => {
  res.json({
    formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, codec: f.codec, audio: f.audio })),
    resolutions: Object.keys(RESOLUTIONS).map((id) => ({ id, ...outputSize(id, '16:9'), allowed: RESOLUTIONS[id] <= RESOLUTIONS[LIMITS.maxResolution] })),
    aspects: Object.keys(ASPECTS), fps: FPS, qualities: QUALITIES, limits: { ...LIMITS, maxUploadMb: MAX_UPLOAD_MB, maxAudioMb: MAX_AUDIO_MB },
    presets: PRESETS, presetFields: PRESET_FIELDS,
  });
});

app.post('/api/uploads', limiter(30, 10), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a single .html file.' });
  const head = (await fs.readFile(req.file.path, 'utf8')).slice(0, 4096);
  if (!/<(html|head|body|script|div|svg|!doctype)/i.test(head)) {
    fs.rm(req.file.path, { force: true });
    return res.status(400).json({ error: 'That does not look like an HTML file.' });
  }
  const id = path.basename(req.file.filename, '.html');
  try {
    const info = await probe(req.file.path, { aspect: '16:9', theme: 'light' });
    info.aspect = '16:9'; info.theme = 'light';
    const u = { id, name: req.file.originalname, path: req.file.path, info, createdAt: Date.now(), owner: req.owner, size: req.file.size };
    uploads.set(id, u);
    res.json({ uploadId: id, name: u.name, size: u.size, info });
  } catch (e) {
    fs.rm(req.file.path, { force: true });
    console.error('[probe]', e);
    res.status(422).json({ error: `Could not open the artifact: ${String(e.message).split('\n')[0]}` });
  }
});

// One frame of an uploaded artifact (poster preview). Previews share the render browser, so at most
// PREVIEW_CONCURRENCY run at once; the client only keeps one request in flight and drops stale ones.
const PREVIEW_CONCURRENCY = Math.max(1, +process.env.PREVIEW_CONCURRENCY || 2);
let previewsRunning = 0;
const previewWaiters = [];
async function previewSlot(fn) {
  if (previewsRunning >= PREVIEW_CONCURRENCY) await new Promise((r) => previewWaiters.push(r));
  previewsRunning++;
  try { return await fn(); } finally { previewsRunning--; previewWaiters.shift()?.(); }
}
app.post('/api/uploads/:id/frame', limiter(120, 10), async (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u || u.owner !== req.owner) return res.status(404).json({ error: 'Upload not found or expired. Please upload the file again.' });
  const opts = normalizeOptions(req.body?.options || {});
  const time = Math.max(0, Math.min(LIMITS.maxDuration, +req.body?.time || 0));
  try {
    const image = await previewSlot(() => previewFrame(u.path, { opts, info: u.info, time }));
    res.json({ image, time });
  } catch (e) {
    res.status(422).json({ error: `Could not render a preview: ${String(e.message).split('\n')[0]}` });
  }
});

app.post('/api/watermarks', limiter(30, 10), wmUpload.single('file'), async (req, res) => {
  const type = req.file && imageType(req.file.buffer);
  if (!type) return res.status(400).json({ error: 'The watermark must be a PNG, JPG or WebP image (max 5 MB).' });
  const id = crypto.randomBytes(9).toString('base64url');
  const p = path.join(STORAGE, 'uploads', `wm-${id}.${type}`);
  await fs.writeFile(p, req.file.buffer);
  watermarks.set(id, { path: p, owner: req.owner, createdAt: Date.now() });
  res.json({ watermarkId: id });
});

app.post('/api/audio', limiter(30, 10), audioUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio file: MP3, WAV, M4A, AAC, OGG, FLAC or Opus.' });
  try {
    const { duration } = await probeAudio(req.file.path);
    const id = crypto.randomBytes(9).toString('base64url');
    const name = String(req.file.originalname || 'audio').slice(0, 120);
    audios.set(id, { path: req.file.path, name, duration, owner: req.owner, createdAt: Date.now() });
    res.json({ audioId: id, name, duration });
  } catch (e) {
    fs.rm(req.file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/jobs', limiter(20, 10), (req, res) => {
  const u = uploads.get(String(req.body?.uploadId || ''));
  if (!u || u.owner !== req.owner) return res.status(404).json({ error: 'Upload not found or expired. Please upload the file again.' });
  try {
    const opts = normalizeOptions(req.body.options || {});
    if (opts.watermark) {
      const wm = watermarks.get(String(req.body.options?.watermark?.id || ''));
      if (!wm || wm.owner !== req.owner) return res.status(400).json({ error: 'The watermark image has expired. Please choose it again.' });
      opts.watermark.path = wm.path;
    }
    if (opts.audio) {
      const a = audios.get(opts.audio.track);
      if (!a || a.owner !== req.owner) return res.status(400).json({ error: 'The audio file has expired. Please add it again.' });
      Object.assign(opts.audio, { path: a.path, name: a.name });
      a.createdAt = Date.now(); // used again: keep it for another TTL
    }
    const job = queue.create({ upload: u, opts, owner: req.owner });
    res.status(202).json(queue.public(job));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

const ownJob = (req, res) => {
  const job = queue.get(req.params.id);
  if (!job || job.owner !== req.owner) { res.status(404).json({ error: 'Job not found.' }); return null; }
  return job;
};

app.get('/api/jobs/:id', (req, res) => { const job = ownJob(req, res); if (job) res.json(queue.public(job)); });

app.get('/api/jobs/:id/events', (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(queue.public(job));
  const fn = (data) => send(data);
  queue.on(`job:${job.id}`, fn);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); queue.off(`job:${job.id}`, fn); });
});

app.delete('/api/jobs/:id', (req, res) => { const job = ownJob(req, res); if (job) { queue.cancel(job); res.json(queue.public(job)); } });

app.get('/api/jobs/:id/poster', (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (job.status !== 'done' || !job.result?.poster) return res.status(404).json({ error: 'No poster image for this job.' });
  const slug = (job.title || 'artifact').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'artifact';
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-poster.png"`);
  res.sendFile(job.result.poster);
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (job.status !== 'done') return res.status(409).json({ error: 'Not ready yet.' });
  const f = FORMATS[job.opts.format];
  const slug = (job.title || 'artifact').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'artifact';
  const name = `${slug}-${job.opts.resolution}-${job.opts.fps}fps.${f.ext}`;
  res.setHeader('Content-Type', f.mime);
  if (req.query.inline !== '1') res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(job.outPath, { acceptRanges: true });
});

app.get('/healthz', async (req, res) => {
  try { await getBrowser(); res.json({ ok: true, queued: queue.queue.length, running: queue.running }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${req.path === '/api/watermarks' ? 5 : req.path === '/api/audio' ? MAX_AUDIO_MB : MAX_UPLOAD_MB} MB.` : err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// ------------------------------------------------------------------ housekeeping
setInterval(async () => {
  await queue.sweep(TTL);
  const now = Date.now();
  for (const [id, u] of uploads) {
    const inUse = [...queue.jobs.values()].some((j) => j.uploadId === id && ['queued', 'running'].includes(j.status));
    if (!inUse && now - u.createdAt > TTL) { uploads.delete(id); fs.rm(u.path, { force: true }).catch(() => {}); }
  }
  for (const [id, w] of watermarks) {
    const inUse = [...queue.jobs.values()].some((j) => j.opts.watermark?.path === w.path && ['queued', 'running'].includes(j.status));
    if (!inUse && now - w.createdAt > TTL) { watermarks.delete(id); fs.rm(w.path, { force: true }).catch(() => {}); }
  }
  for (const [id, a] of audios) {
    const inUse = [...queue.jobs.values()].some((j) => j.opts.audio?.path === a.path && ['queued', 'running'].includes(j.status));
    if (!inUse && now - a.createdAt > TTL) { audios.delete(id); fs.rm(a.path, { force: true }).catch(() => {}); }
  }
}, 5 * 60_000).unref();

// leftovers from a previous run
for (const d of ['uploads', 'jobs']) {
  for (const f of fss.readdirSync(path.join(STORAGE, d))) fs.rm(path.join(STORAGE, d, f), { recursive: true, force: true }).catch(() => {});
}

const server = app.listen(PORT, () => console.log(`artifacts-to-mp4 listening on http://localhost:${PORT}`));
getBrowser().catch((e) => console.error('Chromium failed to start:', e.message));
const shutdown = async () => { server.close(); await closeBrowser(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
