import { createFinishing } from './finishing.js';

const $ = (s, r = document) => r.querySelector(s);
const api = window.a2v;

const el = {
  list: $('#list'), empty: $('#empty'), queue: $('#queuePanel'), count: $('#count'), clearDone: $('#clearDone'), cancelAll: $('#cancelAll'),
  format: $('#format'), resolution: $('#resolution'), aspect: $('#aspect'), fps: $('#fps'), quality: $('#quality'), duration: $('#duration'),
  sound: $('#sound'), soundSub: $('#soundSub'), mode: $('#mode'), theme: $('#theme'), startSelector: $('#startSelector'),
  hideSelectors: $('#hideSelectors'), autoHide: $('#autoHide'), workers: $('#workers'), notify: $('#notify'), openWhenDone: $('#openWhenDone'),
  localNet: $('#localNet'), gpu: $('#gpu'), outDir: $('#outDir'), form: $('#form'), convert: $('#convert'), summary: $('#summary'), error: $('#error'),
};

let presets = null;
let fin = null; // presets dropdown + trim / fades / watermark / poster panels (shared with the web app)
let settings = null;
const items = new Map(); // id -> item from main

// ------------------------------------------------------------ helpers
const isOn = (b) => b.getAttribute('aria-checked') === 'true';
const setSwitch = (b, on) => b.setAttribute('aria-checked', on ? 'true' : 'false');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => { if (s == null || !isFinite(s)) return '–'; s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const fmtBytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const active = (it) => ['queued', 'running'].includes(it.status);
function showError(msg) { el.error.textContent = msg || ''; el.error.hidden = !msg; }
const RES_LABEL = { '480p': '480p SD', '720p': '720p HD', '1080p': '1080p Full HD', '1440p': '1440p 2K', '2160p': '4K UHD' };
const ASPECT_LABEL = { '16:9': '16:9 Wide', '9:16': '9:16 Vertical', '1:1': '1:1 Square', '4:5': '4:5 Portrait' };
function sizeFor(resId, aspect) {
  const p = { '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }[resId];
  const [a, b] = aspect.split(':').map(Number);
  const even = (n) => Math.round(n / 2) * 2;
  return a >= b ? { w: even((p * a) / b), h: p } : { w: p, h: even((p * b) / a) };
}
const ICON = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.2v9.6a.8.8 0 0 0 1.2.7l7.4-4.8a.8.8 0 0 0 0-1.4L6.2 2.5A.8.8 0 0 0 5 3.2z"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/></svg>',
  retry: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5"/></svg>',
};

// ------------------------------------------------------------ options
function options() {
  return {
    format: el.format.value, resolution: el.resolution.value, aspect: el.aspect.value, fps: +el.fps.value, quality: el.quality.value,
    sound: isOn(el.sound), duration: el.duration.value ? +el.duration.value : 'auto', mode: el.mode.value, theme: el.theme.value,
    startSelector: el.startSelector.value.trim(), hideSelectors: el.hideSelectors.value.trim(), autoHideControls: isOn(el.autoHide),
    preset: fin ? fin.el.preset.value : 'custom',
    ...(fin ? fin.read() : {}),
  };
}
function applyOptions(o = {}) {
  for (const k of ['format', 'resolution', 'aspect', 'quality', 'mode', 'theme']) if (o[k] != null && [...el[k].options].some((x) => x.value === String(o[k]))) el[k].value = String(o[k]);
  if (o.fps != null) el.fps.value = [...el.fps.options].some((x) => x.value === String(o.fps)) ? String(o.fps) : '30';
  if (o.duration != null) el.duration.value = o.duration === 'auto' ? '' : o.duration;
  if (o.sound != null) setSwitch(el.sound, o.sound);
  if (o.autoHideControls != null) setSwitch(el.autoHide, o.autoHideControls);
  if (o.startSelector != null) el.startSelector.value = o.startSelector;
  if (o.hideSelectors != null) el.hideSelectors.value = o.hideSelectors;
  fin?.apply(o);
  refresh();
}
window.__applyOptions = applyOptions;
window.__a2vTest = { setWatermark: (w) => fin.setWatermark(w), setAudioLibrary: (l) => setLibrary(l) }; // used by the A2V_SMOKE test hook

let previewItem = null; // the artifact the timeline and poster preview show

// ---- per-artifact settings: select a queue row and the Trim fields, the poster time and the Soundtrack
// edit that artifact only. Everything else (format, fades, watermark…) stays shared. No selection = shared.
let selectedId = null;
const overrides = new Map(); // item id -> { trimStart, trimEnd, posterTime, audio } (only artifacts that differ from the shared values)
let sharedTrim = { trimStart: 0, trimEnd: 'auto', posterTime: 'auto', audio: { track: 'artifact' } };
const TRIM_KEYS = ['trimStart', 'trimEnd', 'posterTime', 'audio'];
const pickTrim = (o) => Object.fromEntries(TRIM_KEYS.map((k) => [k, o[k]]));
const val = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
const sameKey = (a, b, k) => val(a[k] ?? (k === 'audio' ? { track: 'artifact' } : undefined)) === val(b[k] ?? (k === 'audio' ? { track: 'artifact' } : undefined));
const sameTrim = (a, b) => TRIM_KEYS.every((k) => sameKey(a, b, k));
let audioLib = []; // [{ id, name, duration }] – the desktop keeps the files' paths in main
const audioName = (a) => (a?.track && a.track !== 'artifact' ? audioLib.find((f) => f.id === a.track)?.name || 'missing file' : "artifact's own sound");
const trimFor = (id) => overrides.get(id) || sharedTrim;
const selectable = (it) => it && !!it.info && it.status !== 'invalid';
function trimText(t) {
  const ts = t.trimStart > 0, te = t.trimEnd !== 'auto';
  const range = ts && te ? `${t.trimStart}–${t.trimEnd} s` : ts ? `from ${t.trimStart} s` : te ? `to ${t.trimEnd} s` : 'full length';
  return t.posterTime !== 'auto' && String(t.posterTime) !== String(sharedTrim.posterTime) ? `${range}, poster at ${t.posterTime} s` : range;
}
function selectItem(id) {
  selectedId = id && selectable(items.get(id)) ? id : null;
  fin.apply(trimFor(selectedId));
  for (const li of el.list.querySelectorAll('.item')) {
    const on = li.dataset.id === selectedId;
    li.classList.toggle('selected', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  refresh();
}
function renderScope() {
  const sel = selectedId && items.get(selectedId);
  const many = items.size > 1;
  for (const box of [$('#trimScope'), $('#posterScope'), $('#audioScope')]) {
    if (!box) continue;
    if (sel) {
      box.innerHTML = `<span>For <b>${esc(sel.info?.title || sel.name)}</b> only.</span>`
        + `<span class="scope-actions">${many ? '<button type="button" class="link" data-scope="all">Use for all artifacts</button>' : ''}`
        + `${overrides.has(sel.id) ? '<button type="button" class="link" data-scope="reset">Use the shared settings</button>' : ''}`
        + '<button type="button" class="link" data-scope="done">Done</button></span>';
    } else box.innerHTML = many ? '<span>Applies to all artifacts. Click one in the queue to give it its own trim, soundtrack and poster frame.</span>' : '';
    box.hidden = !box.innerHTML;
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope]');
  if (!b) return;
  const act = b.dataset.scope;
  if (act === 'all' && selectedId) { sharedTrim = { ...trimFor(selectedId) }; overrides.clear(); selectItem(null); }
  else if (act === 'reset' && selectedId) { overrides.delete(selectedId); fin.apply(sharedTrim); refresh(); }
  else if (act === 'done') selectItem(null);
  for (const it of items.values()) renderItem(it);
});
// A removed file stops being the track of every artifact that used it.
function setLibrary(list, removedId = null) {
  audioLib = list;
  if (removedId) {
    const fix = (t) => (t.audio?.track === removedId ? { ...t, audio: { track: 'artifact' } } : t);
    sharedTrim = fix(sharedTrim);
    for (const [id, t] of overrides) { const f = fix(t); if (sameTrim(f, sharedTrim)) overrides.delete(id); else overrides.set(id, f); }
  }
  fin.setAudioLibrary(list);
  for (const it of items.values()) renderItem(it);
}

function convertTargets() {
  const all = [...items.values()].filter((it) => !active(it) && ['ready', 'done', 'error', 'cancelled'].includes(it.status));
  const fresh = all.filter((it) => it.status !== 'done');
  return fresh.length ? fresh : all;
}

function refresh() {
  if (!presets) return;
  const o = options();
  // The Trim fields belong to the selected artifact, or to everyone when none is selected.
  if (fin) {
    const cur = pickTrim(o);
    if (selectedId && items.has(selectedId)) {
      const before = JSON.stringify(overrides.get(selectedId) || null);
      if (sameTrim(cur, sharedTrim)) overrides.delete(selectedId); else overrides.set(selectedId, cur);
      if (JSON.stringify(overrides.get(selectedId) || null) !== before) renderItem(items.get(selectedId));
    } else sharedTrim = cur;
    renderScope();
  }
  const gif = o.format === 'gif';
  const L = presets.limits;
  const rank = (id) => presets.resolutions.indexOf(id);
  for (const opt of el.resolution.options) {
    opt.disabled = rank(opt.value) > rank(gif ? L.maxGifResolution : L.maxResolution);
    opt.textContent = RES_LABEL[opt.value] || opt.value;
  }
  if (el.resolution.selectedOptions[0]?.disabled) el.resolution.value = gif ? L.maxGifResolution : L.maxResolution;
  for (const opt of el.fps.options) opt.disabled = gif && +opt.value > L.maxGifFps;
  if (el.fps.selectedOptions[0]?.disabled) el.fps.value = String(L.maxGifFps);
  el.sound.disabled = gif;
  el.soundSub.textContent = gif ? 'GIF files have no audio' : isOn(el.sound) ? "Include the artifact's soundtrack" : 'Export silent videos';

  fin.syncPreset(options());
  const s = sizeFor(el.resolution.value, o.aspect);
  const codec = presets.formats.find((f) => f.id === o.format)?.codec;
  const targets = convertTargets();
  // The timeline shows the selected artifact, or the first one that will be converted.
  const sel = selectedId && items.get(selectedId);
  const first = sel || targets.find((t) => t.info?.duration) || targets[0];
  previewItem = first || null;
  const d1 = first ? (el.duration.value ? +el.duration.value : first.info?.duration) : null;
  fin.setOutputSize(s.w, s.h);
  fin.drawTimeline(d1, +el.fps.value, {
    label: sel && items.size > 1 ? `Output: ${sel.info?.title || sel.name}` : targets.length > 1 ? `Output, first of ${targets.length}` : 'Output',
    emptyText: targets.length ? 'Length unknown: set a duration' : 'Add artifacts to see what the videos will contain',
  });
  fin.setSummary([codec, `${s.w}×${s.h}`, `${el.fps.value} fps`, gif || !isOn(el.sound) ? 'No sound' : o.audio.track !== 'artifact' ? 'Custom sound' : 'Sound on', o.watermark?.enabled ? 'Watermark' : '']);
  const allDone = targets.length && targets.every((t) => t.status === 'done');
  el.convert.disabled = !targets.length;
  el.convert.textContent = !targets.length ? 'Convert' : `${allDone ? 'Convert again' : 'Convert'}${targets.length > 1 ? ` ${targets.length} artifacts` : ''}`;
  if (settings) el.outDir.textContent = settings.outputDir;
  try { const { watermark, ...rest } = o; localStorage.setItem('a2v:options', JSON.stringify({ ...rest, ...sharedTrim, watermark: { position: watermark.position, size: watermark.size, opacity: watermark.opacity } })); } catch {}
}

// ------------------------------------------------------------ queue rendering
function chipHtml(it) {
  const i = it.info;
  if (!i) return '';
  const c = [];
  c.push(i.duration ? `<span class="chip ok">${i.duration.toFixed(1)} s</span>` : '<span class="chip warn">length unknown</span>');
  c.push(i.start ? `<span class="chip">starts: ${esc(i.startText || i.start)}</span>` : '<span class="chip">plays on load</span>');
  if (i.webgl && !settings?.useGpu) c.push('<span class="chip warn" title="This artifact draws with WebGL (3D). Without the graphics card it is drawn on the CPU, a few seconds per frame. Turn on Use graphics card (GPU) in App settings, or render at 480p or 720p for a quick look.">WebGL: slow without GPU</span>');
  else if (i.webgl) c.push('<span class="chip">WebGL, GPU on</span>');
  else if (i.webglFailed) c.push('<span class="chip warn" title="The artifact asked for WebGL and the capture browser could not create it, so 3D parts may be blank. Try Use graphics card (GPU) in App settings.">WebGL not available</span>');
  const own = overrides.get(it.id);
  if (own && !['trimStart', 'trimEnd', 'posterTime'].every((k) => sameKey(own, sharedTrim, k))) c.push(`<span class="chip own" title="This artifact has its own trim">Trim: ${esc(trimText(own))}</span>`);
  if (own && !sameKey(own, sharedTrim, 'audio')) c.push(`<span class="chip own" title="This artifact has its own soundtrack">Audio: ${esc(audioName(own.audio))}</span>`);
  return `<div class="chips">${c.join('')}</div>`;
}

const STAGES = { queued: 'Queued', probing: 'Inspecting', loading: 'Loading renderers', capturing: 'Capturing', encoding: 'Encoding', audio: 'Rendering sound', finalizing: 'Finishing', poster: 'Saving poster' };

function stateHtml(it) {
  const j = it.job;
  const btn = (act, icon, title) => `<button type="button" class="icon-btn" data-act="${act}" title="${title}" aria-label="${title}">${ICON[icon]}</button>`;
  switch (it.status) {
    case 'probing': return '<div class="label">Opening…</div>';
    case 'invalid': return `<div class="label bad">Can't open</div><div class="sub">${esc(it.error)}</div><div class="row-actions">${btn('remove', 'x', 'Remove')}</div>`;
    case 'ready': return `<div class="label">Ready</div><div class="row-actions">${btn('remove', 'x', 'Remove')}</div>`;
    case 'queued': return `<div class="label">Queued</div><div class="row-actions">${btn('cancel', 'stop', 'Cancel')}</div>`;
    case 'running': {
      const p = j?.progress || {};
      const pct = p.stage === 'capturing' ? (p.progress || 0) * 92 : { encoding: 94, audio: 96, finalizing: 97, poster: 99 }[p.stage];
      const sub = p.stage === 'capturing' ? `${p.frame.toLocaleString()} of ${p.frames.toLocaleString()} frames${p.eta != null ? `, ${fmtTime(p.eta)} left` : ''}` : (p.frames ? `${p.frames.toLocaleString()} frames` : '');
      return `<div class="label">${STAGES[p.stage] || 'Working'}${pct != null ? ` <span class="pct">${Math.floor(pct)}%</span>` : ''}</div>
        <div class="bar${pct == null ? ' indeterminate' : ''}"><i data-pct="${pct == null ? '' : pct.toFixed(1)}"></i></div>
        <div class="sub mono">${esc(sub)}</div><div class="row-actions">${btn('cancel', 'stop', 'Cancel')}</div>`;
    }
    case 'done': {
      const r = j.result;
      const audio = r.audio?.source && !['none detected', 'off', 'none'].includes(r.audio.source) ? 'with sound' : 'silent';
      return `<div class="label ok">Saved <span class="pct">${fmtBytes(r.bytes)}</span></div>
        <div class="sub mono">${r.width}×${r.height}, ${r.fps} fps, ${audio}. Took ${fmtTime(r.seconds)}${r.captureFps ? ` at ${r.captureFps} frames/s` : ''}</div>
        <div class="row-actions">${btn('open', 'play', 'Play video')}${r.poster ? btn('poster', 'image', 'Open poster image') : ''}${btn('reveal', 'folder', 'Show in folder')}${btn('remove', 'x', 'Remove from list')}</div>`;
    }
    case 'cancelled': return `<div class="label">Cancelled</div><div class="row-actions">${btn('remove', 'x', 'Remove')}</div>`;
    case 'error': return `<div class="label bad">Failed</div><div class="sub">${esc(j?.error)}</div><div class="row-actions"><button type="button" class="link" data-act="log">Open log</button>${btn('remove', 'x', 'Remove')}</div>`;
    default: return '';
  }
}

function renderItem(it) {
  let li = el.list.querySelector(`[data-id="${it.id}"]`);
  if (!li) {
    li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = it.id;
    li.tabIndex = 0;
    li.innerHTML = '<div class="thumb"></div><div class="meta"></div><div class="state"></div>';
    el.list.appendChild(li);
  }
  const thumb = $('.thumb', li);
  if (it.info?.poster) { if (!thumb.dataset.set) { thumb.style.backgroundImage = `url("${it.info.poster}")`; thumb.dataset.set = '1'; thumb.innerHTML = ''; } }
  else if (it.status === 'probing') thumb.innerHTML = '<span class="spinner"></span>';
  $('.meta', li).innerHTML = `<div class="title" title="${esc(it.info?.title || it.name)}">${esc(it.info?.title || it.name)}</div>
    <div class="file mono" title="${esc(it.status === 'done' ? it.job.outPath : it.path)}">${it.status === 'done' ? esc(it.job.outPath.split(/[\\/]/).pop()) : esc(it.path)}</div>${chipHtml(it)}`;
  $('.state', li).innerHTML = stateHtml(it);
  li.classList.toggle('selected', it.id === selectedId);
  li.classList.toggle('selectable', selectable(it));
  li.setAttribute('aria-selected', it.id === selectedId ? 'true' : 'false');
  const bar = $('.bar i[data-pct]', li); // CSP forbids inline style attributes, so set width via CSSOM
  if (bar && bar.dataset.pct) bar.style.width = `${bar.dataset.pct}%`;
}

function renderAll() {
  const list = [...items.values()];
  el.empty.hidden = list.length > 0;
  el.list.hidden = list.length === 0;
  el.count.textContent = list.length ? String(list.length) : '';
  el.clearDone.hidden = !list.some((it) => ['done', 'error', 'cancelled', 'invalid'].includes(it.status));
  el.cancelAll.hidden = list.filter(active).length < 2;
  refresh();
}

api.onItem((it) => { items.set(it.id, it); renderItem(it); renderAll(); });

el.list.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) {
    // a click anywhere else on a row selects it (again = deselect)
    const li = e.target.closest('.item');
    if (li && !e.target.closest('button, a, input, select')) selectItem(selectedId === li.dataset.id ? null : li.dataset.id);
    return;
  }
  const id = b.closest('.item').dataset.id;
  const it = items.get(id);
  switch (b.dataset.act) {
    case 'remove': if (await api.removeItem(id)) { items.delete(id); overrides.delete(id); b.closest('.item').remove(); if (selectedId === id) selectItem(null); renderAll(); } break;
    case 'cancel': api.cancel(id); break;
    case 'open': api.openPath(it.job.outPath); break;
    case 'reveal': api.reveal(it.job.outPath); break;
    case 'poster': api.openPath(it.job.result.poster); break;
    case 'log': api.openLog(); break;
  }
});
el.clearDone.addEventListener('click', async () => {
  const left = await api.clearFinished();
  const keep = new Set(left.map((i) => i.id));
  for (const id of [...items.keys()]) if (!keep.has(id)) { items.delete(id); overrides.delete(id); el.list.querySelector(`[data-id="${id}"]`)?.remove(); }
  if (selectedId && !items.has(selectedId)) selectItem(null);
  renderAll();
});
el.cancelAll.addEventListener('click', () => api.cancelAll());
el.list.addEventListener('keydown', (e) => {
  const li = e.target.closest('.item');
  if (li && e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectItem(selectedId === li.dataset.id ? null : li.dataset.id); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedId && !e.target.closest('input, select, textarea')) selectItem(null);
});

// ------------------------------------------------------------ adding files
const pick = async () => { showError(''); await api.pickFiles(); };
$('#addBtn').addEventListener('click', pick);
$('#addInline').addEventListener('click', pick);
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; el.queue.classList.add('over'); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; el.queue.classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; el.queue.classList.remove('over');
  const files = [...(e.dataTransfer?.files || [])];
  const html = files.filter((f) => /\.html?$/i.test(f.name));
  if (!html.length) return showError('Only .html files can be added.');
  showError('');
  await api.addFiles(html);
});

// ------------------------------------------------------------ convert
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const targets = convertTargets();
  const o = options();
  const unknown = targets.filter((t) => !t.info?.duration);
  if (o.duration === 'auto' && unknown.length) { el.duration.focus(); return showError(`Set a duration: the length of ${unknown.map((u) => u.name).join(', ')} could not be detected.`); }
  for (const t of targets) {
    const err = fin.timing(o.duration === 'auto' ? t.info?.duration : o.duration, trimFor(t.id)).error;
    if (err) {
      if (overrides.has(t.id) && selectedId !== t.id) selectItem(t.id); // show the artifact whose own trim is wrong
      $('#trimBox').open = true;
      return showError(targets.length > 1 ? `${t.name}: ${err}` : err);
    }
  }
  showError('');
  el.convert.disabled = true;
  const perItem = Object.fromEntries(targets.filter((t) => overrides.has(t.id)).map((t) => [t.id, overrides.get(t.id)]));
  try { await api.convert(targets.map((t) => t.id), { ...o, ...sharedTrim }, perItem); } catch (err) { showError(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); refresh(); }
});

// ------------------------------------------------------------ settings
[el.format, el.resolution, el.aspect, el.fps, el.quality, el.mode, el.theme].forEach((s) => s.addEventListener('change', refresh));
[el.duration, el.startSelector, el.hideSelectors].forEach((s) => s.addEventListener('input', refresh));
[el.sound, el.autoHide].forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { setSwitch(b, !isOn(b)); refresh(); } }));
const appToggle = (b, key) => b.addEventListener('click', async () => { setSwitch(b, !isOn(b)); settings = await api.setSettings({ [key]: isOn(b) }); if (key === 'useGpu') for (const it of items.values()) renderItem(it); });
appToggle(el.notify, 'notify'); appToggle(el.gpu, 'useGpu'); appToggle(el.openWhenDone, 'openFolderWhenDone'); appToggle(el.localNet, 'allowLocalNetwork');
el.workers.addEventListener('change', async () => { settings = await api.setSettings({ renderWorkers: +el.workers.value }); });
$('#changeOut').addEventListener('click', async () => { settings = await api.chooseOutputDir(); refresh(); });
el.outDir.addEventListener('click', () => api.openOutputDir());

function renderCheck(c) {
  const f = $('#chkFfmpeg'), b = $('#chkBrowser');
  if (!c || c.pending) { f.className = b.className = 'check mono'; f.textContent = 'FFmpeg: checking…'; b.textContent = 'Capture browser: checking…'; return; }
  f.className = `check mono ${c.ffmpeg.ok ? 'ok' : 'bad'}`;
  f.textContent = c.ffmpeg.ok ? `FFmpeg ready${c.ffmpeg.missing?.length ? ` (missing: ${c.ffmpeg.missing.join(', ')})` : ''}` : `FFmpeg: ${c.ffmpeg.error}`;
  b.className = `check mono ${c.browser.ok ? 'ok' : 'bad'}`;
  b.textContent = c.browser.ok ? `Chromium ${c.browser.version} (${c.browser.source === 'bundled' ? 'bundled' : `using installed ${c.browser.source === 'msedge' ? 'Edge' : c.browser.source}`})` : `Capture browser: ${c.browser.error}`;
  const g = $('#chkGpu');
  g.className = 'check mono';
  g.textContent = c.browser.ok && c.browser.graphics ? `Graphics: ${c.browser.graphics}${c.browser.gpu ? ' (GPU mode on)' : ''}` : '';
  if (!c.ffmpeg.ok || !c.browser.ok) {
    el.error.innerHTML = `${esc(!c.ffmpeg.ok ? c.ffmpeg.error : c.browser.error)} Videos can't be made until this is fixed.<button type="button" class="link" id="errLog">Open log</button>`;
    el.error.hidden = false;
    $('#errLog').addEventListener('click', () => api.openLog());
  }
}
api.onSystemCheck(renderCheck);
$('#openLog').addEventListener('click', () => api.openLog());
$('#recheck').addEventListener('click', async () => { renderCheck(await api.rerunSystemCheck()); });

async function init() {
  const s = await api.init();
  presets = s.presets; settings = s.settings;
  const fill = (sel, list, map = (x) => x) => { sel.innerHTML = list.map((v) => `<option value="${esc(v)}">${esc(map(v))}</option>`).join(''); };
  el.format.innerHTML = presets.formats.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('');
  fill(el.resolution, presets.resolutions, (r) => RES_LABEL[r] || r);
  fill(el.aspect, presets.aspects, (a) => ASPECT_LABEL[a] || a);
  fill(el.fps, presets.fps, (f) => `${f} fps`);
  el.resolution.value = '1080p'; el.fps.value = '30';
  fill(el.workers, Array.from({ length: s.cpus }, (_, i) => i + 1), (n) => `${n}${n === Math.max(1, Math.min(4, s.cpus)) ? ' (recommended)' : ''}`);
  el.workers.value = String(settings.renderWorkers);
  setSwitch(el.notify, settings.notify); setSwitch(el.gpu, !!settings.useGpu); setSwitch(el.openWhenDone, settings.openFolderWhenDone); setSwitch(el.localNet, settings.allowLocalNetwork);
  $('#ver').textContent = `Version ${s.version}, ${s.cpus} CPU cores`;
  $('#syscheck').hidden = !s.debug;
  fin = createFinishing({ presets: presets.presets, presetFields: presets.presetFields, onChange: refresh,
    onChooseWatermark: async () => { const w = await api.pickWatermark(); if (w) fin.setWatermark(w); },
    onAddAudio: async () => {
      const r = await api.pickAudio();
      if (!r) return [];
      if (r.errors?.length) showError(r.errors.join(' '));
      setLibrary(r.library);
      return r.added;
    },
    onRemoveAudio: async (id) => setLibrary(await api.removeAudio(id), id),
    soundState: () => (el.format.value === 'gif' ? 'gif' : isOn(el.sound) ? 'on' : 'off'),
    // poster preview: one frame of the first artifact in the queue (the one the timeline shows)
    previewFrame: (time) => (previewItem ? api.previewFrame(previewItem.id, time, options()) : null),
    previewKey: () => { const o = options(); return previewItem ? `${previewItem.id}|${[o.aspect, o.theme, o.mode, o.startSelector, o.hideSelectors, o.autoHideControls].join('|')}` : ''; } });
  fin.onPreset((p) => {
    for (const k of ['format', 'resolution', 'aspect', 'quality']) if (p[k] !== undefined) el[k].value = p[k];
    if (p.fps !== undefined) el.fps.value = String(p.fps);
    if (p.sound !== undefined) setSwitch(el.sound, p.sound);
    refresh();
  });
  if (s.watermark) fin.setWatermark(s.watermark, { enable: false });
  setLibrary(s.audioFiles || []); // before the saved options, so a saved track can be selected
  let saved = settings.options;
  try { saved = JSON.parse(localStorage.getItem('a2v:options')) || saved; } catch {}
  applyOptions(saved || {});
  for (const it of s.items) { items.set(it.id, it); renderItem(it); }
  renderCheck(await api.systemCheck());
  renderAll();
}
init().catch((e) => showError(e.message));
