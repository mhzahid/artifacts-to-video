// In-memory job queue. One process, RENDER_CONCURRENCY jobs at a time (each job already
// renders with several browser pages in parallel). For multiple servers, swap this module
// for BullMQ + Redis — the API surface (create / get / cancel / subscribe) stays the same.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { render } from './render/renderer.js';
import { FORMATS } from './render/presets.js';

const CONCURRENCY = Math.max(1, +process.env.RENDER_CONCURRENCY || 1);
const QUEUE_MAX = Math.max(1, +process.env.QUEUE_MAX || 20);
const JOB_TIMEOUT = (+process.env.JOB_TIMEOUT_MIN || 30) * 60_000;

export class JobQueue extends EventEmitter {
  // exposePaths: include local file paths (watermark, poster) in public job data. Only the desktop
  // app sets it; the web server must never reveal server paths to browsers.
  constructor(storageDir, { exposePaths = false } = {}) {
    super();
    this.exposePaths = exposePaths;
    this.dir = storageDir;
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.setMaxListeners(1000);
  }

  create({ upload, opts, owner, outPath = null, assetDir = null }) {
    if (this.queue.length >= QUEUE_MAX) { const e = new Error('The render queue is full. Try again in a few minutes.'); e.status = 503; throw e; }
    const id = crypto.randomBytes(9).toString('base64url');
    const job = {
      id, owner, opts, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
      uploadId: upload.id, title: upload.info?.title || upload.name, inputPath: upload.path, info: upload.info,
      progress: { stage: 'queued' }, result: null, error: null, ac: new AbortController(),
      dir: path.join(this.dir, 'jobs', id), requestedOut: outPath, assetDir,
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.#emit(job);
    this.#pump();
    return job;
  }

  get(id) { return this.jobs.get(id); }

  position(job) { const i = this.queue.indexOf(job); return i < 0 ? 0 : i + 1; }

  cancel(job) {
    if (job.status === 'queued') {
      this.queue = this.queue.filter((j) => j !== job);
      job.status = 'cancelled';
      this.#emit(job);
    } else if (job.status === 'running') job.ac.abort();
  }

  public(job) {
    let { opts, result } = job;
    if (!this.exposePaths) {
      opts = opts.watermark ? { ...opts, watermark: { ...opts.watermark, path: undefined } } : opts;
      opts = opts.audio ? { ...opts, audio: { ...opts.audio, path: undefined } } : opts;
      result = result ? { ...result, poster: !!result.poster } : result;
    }
    return {
      id: job.id, status: job.status, title: job.title, opts, createdAt: job.createdAt,
      position: this.position(job), progress: job.progress, result, error: job.error,
      uploadId: job.uploadId, outPath: this.exposePaths ? job.requestedOut || null : null,
      download: job.status === 'done' ? `/api/jobs/${job.id}/download` : null,
      posterDownload: job.status === 'done' && job.result?.poster ? `/api/jobs/${job.id}/poster` : null,
    };
  }

  #emit(job) { job.updatedAt = Date.now(); const pub = this.public(job); this.emit(`job:${job.id}`, pub); this.emit('update', pub); if (job.status !== 'running') this.queue.forEach((q) => this.emit(`job:${q.id}`, this.public(q))); }

  #pump() {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      this.#run(job).finally(() => { this.running--; this.#pump(); });
    }
  }

  async #run(job) {
    job.status = 'running';
    this.#emit(job);
    const timer = setTimeout(() => { job.timedOut = true; job.ac.abort(); }, JOB_TIMEOUT);
    const workDir = path.join(job.dir, 'work');
    try {
      await fs.mkdir(workDir, { recursive: true });
      const ext = FORMATS[job.opts.format].ext;
      job.outPath = job.requestedOut || path.join(job.dir, `output.${ext}`);
      const sameProbe = job.info && job.info.aspect === job.opts.aspect && job.info.theme === job.opts.theme;
      let last = 0;
      job.result = await render({
        htmlPath: job.inputPath, outPath: job.outPath, workDir, opts: job.opts, signal: job.ac.signal, assetDir: job.assetDir,
        log: (msg) => { this.emit('log', { id: job.id, msg }); if (process.env.A2V_VERBOSE) console.log(`[job ${job.id}] ${msg}`); },
        info: sameProbe ? job.info : undefined,
        onProgress: (p) => {
          job.progress = p;
          const now = Date.now();
          if (p.stage !== 'capturing' || now - last > 400) { last = now; this.#emit(job); }
        },
      });
      job.status = 'done';
      job.progress = { stage: 'done', progress: 1 };
    } catch (e) {
      job.status = job.ac.signal.aborted && !job.timedOut ? 'cancelled' : 'error';
      if (job.requestedOut) fs.rm(job.outPath, { force: true }).catch(() => {}); // no half-written files on the user's disk
      job.error = job.status === 'cancelled' ? 'Cancelled' : job.timedOut ? 'The render took too long and was stopped.' : friendly(e);
      if (job.status === 'error') console.error(`[job ${job.id}]`, e);
    } finally {
      clearTimeout(timer);
      fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      this.#emit(job);
    }
  }

  // Remove finished jobs (and their files) after ttl ms.
  async sweep(ttl) {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (['done', 'error', 'cancelled'].includes(job.status) && now - job.updatedAt > ttl) {
        this.jobs.delete(job.id);
        await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/Timeout .*exceeded/i.test(m) && /goto/i.test(m)) return 'The artifact took too long to load.';
  if (/Target page, context or browser has been closed/i.test(m)) return 'The render browser crashed (out of memory?). Try a lower resolution.';
  return m.split('\n')[0].slice(0, 300);
}
