import { createFinishing } from './finishing.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(`a2v:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`a2v:${k}`, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(`a2v:${k}`); } catch {} },
};

const el = {
  drop: $('#drop'), file: $('#file'), poster: $('#poster'), fileName: $('#fileName'), chips: $('#chips'),
  format: $('#format'), resolution: $('#resolution'), aspect: $('#aspect'), fps: $('#fps'), quality: $('#quality'),
  duration: $('#duration'), sound: $('#sound'), soundSub: $('#soundSub'), mode: $('#mode'), theme: $('#theme'),
  startSelector: $('#startSelector'), hideSelectors: $('#hideSelectors'), autoHide: $('#autoHide'),
  form: $('#form'), convert: $('#convert'), summary: $('#summary'),
  progress: $('#progress'), progStage: $('#progStage'), barFill: $('#barFill'), progStats: $('#progStats'), cancel: $('#cancel'),
  result: $('#result'), resultTitle: $('#resultTitle'), resultMeta: $('#resultMeta'), preview: $('#preview'), gifPreview: $('#gifPreview'),
  download: $('#download'), again: $('#again'), error: $('#error'), posterLink: $('#posterLink'), wmFile: $('#wmFile'),
  audioFile: $('#audioFile'),
};

let presets = null;
let fin = null; // presets dropdown + trim / fades / watermark / poster panels
let uploadInfo = null; // { uploadId, name, info }
let currentJob = null;
let es = null;
// Soundtrack files uploaded in this page session: [{ id, name, duration }]. Not saved across reloads,
// because the server deletes unused uploads after a while.
let audioLib = [];

// ------------------------------------------------------------ helpers
const fmtTime = (s) => { if (s == null || !isFinite(s)) return '–'; s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const fmtBytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const setSwitch = (b, on) => b.setAttribute('aria-checked', on ? 'true' : 'false');
const isOn = (b) => b.getAttribute('aria-checked') === 'true';
function showError(msg) { el.error.textContent = msg; el.error.hidden = !msg; }
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function sizeFor(resId, aspect) {
  const p = { '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }[resId];
  const [a, b] = aspect.split(':').map(Number);
  const even = (n) => Math.round(n / 2) * 2;
  return a >= b ? { w: even((p * a) / b), h: p } : { w: p, h: even((p * b) / a) };
}

// ------------------------------------------------------------ settings
function options() {
  return {
    format: el.format.value, resolution: el.resolution.value, aspect: el.aspect.value, fps: +el.fps.value, quality: el.quality.value,
    sound: isOn(el.sound), duration: el.duration.value ? +el.duration.value : 'auto', mode: el.mode.value, theme: el.theme.value,
    startSelector: el.startSelector.value.trim(), hideSelectors: el.hideSelectors.value.trim(), autoHideControls: isOn(el.autoHide),
    preset: fin ? fin.el.preset.value : 'custom',
    ...(fin ? fin.read() : {}),
  };
}

function refresh() {
  const o = options();
  const gif = o.format === 'gif';
  const L = presets.limits;
  const rank = (id) => presets.resolutions.findIndex((r) => r.id === id);
  // resolution labels follow the aspect ratio; GIF caps resolution and fps
  for (const opt of el.resolution.options) {
    const s = sizeFor(opt.value, o.aspect);
    const maxRes = gif ? L.maxGifResolution : L.maxResolution;
    opt.disabled = rank(opt.value) > rank(maxRes);
    opt.textContent = { '480p': '480p SD', '720p': '720p HD', '1080p': '1080p Full HD', '1440p': '1440p 2K', '2160p': '4K UHD' }[opt.value];
  }
  if (el.resolution.selectedOptions[0]?.disabled) el.resolution.value = gif ? L.maxGifResolution : L.maxResolution;
  for (const opt of el.fps.options) opt.disabled = gif && +opt.value > L.maxGifFps;
  if (el.fps.selectedOptions[0]?.disabled) el.fps.value = String(L.maxGifFps);

  el.sound.disabled = gif;
  el.soundSub.textContent = gif ? 'GIF files have no audio' : (isOn(el.sound) ? "Include the artifact's soundtrack" : 'Export a silent video');

  fin.syncPreset(options());
  const dur = el.duration.value ? +el.duration.value : uploadInfo?.info?.duration;
  const t = fin.timing(dur);
  const s = sizeFor(el.resolution.value, o.aspect);
  const codec = presets.formats.find((f) => f.id === o.format)?.codec;
  fin.setOutputSize(s.w, s.h);
  fin.drawTimeline(dur, +el.fps.value);
  fin.setSummary([codec, `${s.w}×${s.h}`, `${el.fps.value} fps`, gif || !isOn(el.sound) ? 'No sound' : o.audio.track !== 'artifact' ? 'Custom sound' : 'Sound on', o.watermark?.enabled ? 'Watermark' : '']);
  el.convert.disabled = !uploadInfo || (currentJob && ['queued', 'running'].includes(currentJob.status));
  const { watermark, audio, ...persist } = options();
  store.set('settings', { ...persist, watermark: { position: watermark.position, size: watermark.size, opacity: watermark.opacity },
    audio: audio.track === 'artifact' ? null : { mix: audio.mix, volume: audio.volume, loop: audio.loop } });
}

function fillSelect(sel, items, value) {
  sel.innerHTML = items.map((i) => `<option value="${i.value}">${i.label}</option>`).join('');
  if (value != null && items.some((i) => String(i.value) === String(value))) sel.value = String(value);
}

async function init() {
  presets = await api('/api/presets');
  const saved = store.get('settings', {});
  fin = createFinishing({ presets: presets.presets, presetFields: presets.presetFields, onChange: refresh,
    onChooseWatermark: async () => { el.wmFile.value = ''; el.wmFile.click(); },
    onAddAudio: async () => { el.audioFile.value = ''; el.audioFile.click(); },
    onRemoveAudio: async (id) => { audioLib = audioLib.filter((a) => a.id !== id); fin.setAudioLibrary(audioLib); },
    soundState: () => (el.format.value === 'gif' ? 'gif' : isOn(el.sound) ? 'on' : 'off'),
    // poster preview: one frame of the uploaded artifact, rendered by the server
    previewFrame: async (time) => {
      if (!uploadInfo) return null;
      const r = await api(`/api/uploads/${encodeURIComponent(uploadInfo.uploadId)}/frame`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time, options: options() }) });
      return r.image;
    },
    previewKey: () => { const o = options(); return uploadInfo ? `${uploadInfo.uploadId}|${[o.aspect, o.theme, o.mode, o.startSelector, o.hideSelectors, o.autoHideControls].join('|')}` : ''; } });
  fin.onPreset((p) => {
    for (const k of ['format', 'resolution', 'aspect', 'quality']) if (p[k] !== undefined) el[k].value = p[k];
    if (p.fps !== undefined) el.fps.value = String(p.fps);
    if (p.sound !== undefined) setSwitch(el.sound, p.sound);
    refresh();
  });
  fin.apply(saved);
  fin.setAudioLibrary([]);
  if (saved.audio) fin.apply({ audio: { track: 'artifact', ...saved.audio } });
  fillSelect(el.format, presets.formats.map((f) => ({ value: f.id, label: f.label })), saved.format || 'mp4');
  fillSelect(el.resolution, presets.resolutions.map((r) => ({ value: r.id, label: r.id })), saved.resolution || '1080p');
  fillSelect(el.aspect, presets.aspects.map((a) => ({ value: a, label: { '16:9': '16:9 Wide', '9:16': '9:16 Vertical', '1:1': '1:1 Square', '4:5': '4:5 Portrait' }[a] || a })), saved.aspect || '16:9');
  fillSelect(el.fps, presets.fps.map((f) => ({ value: f, label: `${f} fps` })), presets.fps.includes(+saved.fps) ? saved.fps : 30);
  if (saved.quality) el.quality.value = saved.quality;
  if (saved.mode) el.mode.value = saved.mode;
  if (saved.theme) el.theme.value = saved.theme;
  if (saved.sound === false) setSwitch(el.sound, false);
  if (saved.autoHideControls === false) setSwitch(el.autoHide, false);
  $('#maxUp').textContent = presets.limits.maxUploadMb;
  el.duration.max = presets.limits.maxDuration;
  refresh();

  const jobId = store.get('job');
  if (jobId) {
    try { const job = await api(`/api/jobs/${jobId}`); currentJob = job; renderJob(job); if (['queued', 'running'].includes(job.status)) subscribe(job.id); }
    catch { store.del('job'); }
  }
}

[el.format, el.resolution, el.aspect, el.fps, el.quality, el.mode, el.theme].forEach((s) => s.addEventListener('change', refresh));
[el.duration, el.startSelector, el.hideSelectors].forEach((s) => s.addEventListener('input', refresh));
[el.sound, el.autoHide].forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { setSwitch(b, !isOn(b)); refresh(); } }));

// ------------------------------------------------------------ upload
function setDropState(state) {
  el.drop.querySelector('.drop-empty').hidden = state !== 'empty';
  el.drop.querySelector('.drop-busy').hidden = state !== 'busy';
  el.drop.querySelector('.drop-file').hidden = state !== 'file';
  el.drop.classList.toggle('has-file', state === 'file');
}

async function handleFile(f) {
  if (!f) return;
  showError('');
  if (!/\.html?$/i.test(f.name)) return showError('Please choose an .html file.');
  if (f.size > presets.limits.maxUploadMb * 1e6) return showError(`That file is larger than ${presets.limits.maxUploadMb} MB.`);
  setDropState('busy');
  const fd = new FormData();
  fd.append('file', f);
  try {
    uploadInfo = await api('/api/uploads', { method: 'POST', body: fd });
    const i = uploadInfo.info;
    el.poster.src = i.poster;
    el.fileName.textContent = i.title || uploadInfo.name;
    const chips = [];
    chips.push(i.duration ? `<span class="chip ok">${i.duration.toFixed(1)} s, from ${i.durationSource}</span>` : '<span class="chip warn">Length unknown, set a duration</span>');
    chips.push(i.start ? `<span class="chip ok">Starts with: ${escapeHtml(i.startText || i.start)}</span>` : '<span class="chip">Plays on load</span>');
    if (i.webgl) chips.push('<span class="chip warn" title="This artifact draws with WebGL (3D). The server has no graphics card, so each frame is drawn on the CPU: expect a few seconds per frame at 1080p. 480p or 720p is much faster for a preview.">WebGL: slow to render</span>');
    else if (i.webglFailed) chips.push('<span class="chip warn" title="The artifact asked for WebGL and the capture browser could not create it, so 3D parts may be blank.">WebGL not available</span>');
    chips.push(`<span class="chip">${fmtBytes(uploadInfo.size)}</span>`);
    el.chips.innerHTML = chips.join('');
    el.duration.placeholder = i.duration ? `Auto (${i.duration.toFixed(1)})` : 'Required';
    setDropState('file');
    el.result.hidden = true;
  } catch (e) {
    uploadInfo = null;
    setDropState('empty');
    showError(e.message);
  }
  refresh();
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

el.file.addEventListener('change', () => handleFile(el.file.files[0]));
el.drop.addEventListener('click', (e) => { if (el.drop.classList.contains('has-file')) e.preventDefault(); });
el.drop.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !el.drop.classList.contains('has-file')) { e.preventDefault(); el.file.click(); } });
$('#replace').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); el.file.value = ''; el.file.click(); });
['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

// ------------------------------------------------------------ watermark image
el.wmFile.addEventListener('change', async () => {
  const f = el.wmFile.files[0];
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return showError('The watermark must be a PNG, JPG or WebP image.');
  if (f.size > 5e6) return showError('The watermark image must be smaller than 5 MB.');
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await api('/api/watermarks', { method: 'POST', body: fd });
    fin.setWatermark({ name: f.name, thumb: URL.createObjectURL(f), id: r.watermarkId });
    showError('');
  } catch (e) { showError(e.message); }
  refresh();
});

// ------------------------------------------------------------ soundtrack files
el.audioFile.addEventListener('change', async () => {
  const files = [...el.audioFile.files];
  if (!files.length) return;
  const max = presets.limits.maxAudioMb || 30;
  const add = $('#audioAdd'), label = add.textContent;
  add.disabled = true;
  const added = [], errors = [];
  for (const [i, f] of files.entries()) {
    if (f.size > max * 1e6) { errors.push(`${f.name} is larger than ${max} MB.`); continue; }
    add.textContent = files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…';
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await api('/api/audio', { method: 'POST', body: fd });
      audioLib.push({ id: r.audioId, name: r.name, duration: r.duration });
      added.push(r.audioId);
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  add.textContent = label; add.disabled = false;
  const before = fin.read().audio.track;
  fin.setAudioLibrary(audioLib);
  // the first new file becomes the track if the artifact's own sound was in use
  if (added.length && before === 'artifact') fin.apply({ audio: { track: added[0] } });
  showError(errors.join(' '));
  refresh();
});

// ------------------------------------------------------------ jobs
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!uploadInfo) return;
  const o = options();
  if (o.duration === 'auto' && !uploadInfo.info.duration) { el.duration.focus(); return showError('Set the duration: the animation length could not be detected.'); }
  const t = fin.timing(o.duration === 'auto' ? uploadInfo.info.duration : o.duration);
  if (t.error) { $('#trimBox').open = true; return showError(t.error); }
  showError('');
  el.convert.disabled = true;
  try {
    const job = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: uploadInfo.uploadId, options: o }) });
    currentJob = job;
    store.set('job', job.id);
    renderJob(job);
    subscribe(job.id);
  } catch (err) { showError(err.message); refresh(); }
});

function subscribe(id) {
  es?.close();
  es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (m) => { const job = JSON.parse(m.data); currentJob = job; renderJob(job); if (!['queued', 'running'].includes(job.status)) es.close(); };
  es.onerror = () => {
    es.close();
    // fall back to polling (e.g. a proxy that buffers SSE)
    setTimeout(async () => {
      try { const job = await api(`/api/jobs/${id}`); currentJob = job; renderJob(job); if (['queued', 'running'].includes(job.status)) subscribe(id); } catch {}
    }, 1500);
  };
}

const STAGES = { queued: 'Queued', probing: 'Inspecting artifact', loading: 'Loading renderers', capturing: 'Capturing frames',
  encoding: 'Encoding video', audio: 'Rendering soundtrack', finalizing: 'Finishing video', poster: 'Saving poster image', done: 'Done' };

function renderJob(job) {
  const active = ['queued', 'running'].includes(job.status);
  el.progress.hidden = !active;
  if (active) {
    const p = job.progress || {};
    el.progStage.textContent = STAGES[p.stage] || 'Working';
    const bar = el.barFill.parentElement;
    const pct = p.stage === 'capturing' ? (p.progress || 0) * 92 : { encoding: 94, audio: 96, finalizing: 97, poster: 99 }[p.stage];
    bar.classList.toggle('indeterminate', pct == null);
    el.barFill.style.width = pct == null ? '' : `${pct.toFixed(1)}%`;
    bar.setAttribute('aria-valuenow', pct == null ? 0 : Math.round(pct));
    const stats = [];
    if (job.status === 'queued') stats.push(job.position > 1 ? `${job.position - 1} job(s) ahead of you` : 'Starting…');
    if (p.stage === 'capturing') {
      stats.push(`frame ${p.frame.toLocaleString()} / ${p.frames.toLocaleString()}`);
      if (p.fps) stats.push(`${p.fps.toFixed(1)} frames/s`);
      if (p.workers > 1) stats.push(`${p.workers} renderers`);
      if (p.eta != null) stats.push(`about ${fmtTime(p.eta)} left`);
    } else if (p.stage === 'loading' && p.frames) {
      stats.push(`${p.frames.toLocaleString()} frames`, `${p.duration.toFixed(1)} s`, p.mode === 'click' ? 'clicking start button' : 'plays on load');
    }
    if (p.elapsed) stats.push(`elapsed ${fmtTime(p.elapsed)}`);
    el.progStats.innerHTML = stats.map((s) => `<span>${escapeHtml(s)}</span>`).join('');
  }
  if (job.status === 'done') {
    const r = job.result;
    el.result.hidden = false;
    el.resultTitle.textContent = 'Your video is ready';
    const audio = r.audio?.source && !['none detected', 'off', 'none'].includes(r.audio.source) ? 'with sound' : 'silent';
    el.resultMeta.textContent = `${r.width}×${r.height}, ${r.fps} fps, ${r.duration.toFixed(1)} s, ${fmtBytes(r.bytes)}, ${audio}. Rendered in ${fmtTime(r.seconds)}`;
    const src = `${job.download}?inline=1`;
    const gif = job.opts.format === 'gif';
    el.gifPreview.hidden = !gif; el.preview.hidden = gif;
    if (gif) el.gifPreview.src = src;
    else if (job.opts.format !== 'mov' || el.preview.canPlayType('video/quicktime')) el.preview.src = `${src}#t=0.8`;
    else el.preview.hidden = true;
    el.download.href = job.download;
    el.posterLink.hidden = !job.posterDownload;
    if (job.posterDownload) el.posterLink.href = job.posterDownload;
  } else if (job.status === 'error' || job.status === 'cancelled') {
    el.result.hidden = true;
    if (job.status === 'error') showError(job.error || 'Render failed.');
  }
  refresh();
}

el.cancel.addEventListener('click', async () => { if (currentJob) { try { renderJob(await api(`/api/jobs/${currentJob.id}`, { method: 'DELETE' })); } catch (e) { showError(e.message); } } });
el.again.addEventListener('click', () => { el.result.hidden = true; el.preview.removeAttribute('src'); store.del('job'); currentJob = null; refresh(); el.convert.focus(); });

init().catch((e) => showError(`Could not reach the server: ${e.message}`));
