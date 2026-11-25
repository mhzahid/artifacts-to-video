// Shared by the web app (public/) and the desktop app (desktop/ui/, copied by `npm run sync`):
// the Preset dropdown, the "Soundtrack", "Trim", "Fades & ending", "Watermark" and "Poster image" panels,
// the output timeline, and the poster-frame preview.

const $ = (s) => document.querySelector(s);
const isOn = (b) => b.getAttribute('aria-checked') === 'true';
const setSwitch = (b, on) => b.setAttribute('aria-checked', on ? 'true' : 'false');
const num = (input) => (input.value === '' ? null : +input.value);

// previewFrame(seconds) → Promise<image URL>: renders the artifact at that moment of its animation
// (host-specific: web API or desktop IPC). previewKey() → string: changes whenever anything other than
// the time would change the picture (file, aspect ratio, theme, start options).
// Soundtrack: the host keeps the audio files (server upload / local path) and passes the library in with
// setAudioLibrary([{ id, name, duration }]). onAddAudio() → Promise<ids added>, onRemoveAudio(id).
// soundState() → 'on' | 'off' | 'gif' (the Sound switch and the format belong to the host).
export function createFinishing({ presets, presetFields, onChange, onChooseWatermark, previewFrame = null, previewKey = () => '',
  onAddAudio = null, onRemoveAudio = null, soundState = () => 'on' }) {
  const el = {
    preset: $('#preset'), trimStart: $('#trimStart'), trimEnd: $('#trimEnd'), hold: $('#hold'), fadeDuration: $('#fadeDuration'),
    fadeIn: $('#fadeIn'), fadeOut: $('#fadeOut'), wmOn: $('#wmOn'), wmBox: $('#wmBox'), wmChoose: $('#wmChoose'), wmThumb: $('#wmThumb'),
    wmName: $('#wmName'), wmPos: $('#wmPos'), wmSize: $('#wmSize'), wmOpacity: $('#wmOpacity'), wmOpacityVal: $('#wmOpacityVal'), posterOn: $('#posterOn'),
    posterTime: $('#posterTime'), trimBadge: $('#trimBadge'), finishBadge: $('#finishBadge'), wmBadge: $('#wmBadge'), posterBadge: $('#posterBadge'),
    timeline: $('#timeline'), summary: $('#summary'),
    posterBox: $('#posterBox'), pp: $('#posterPreview'), scrub: $('#posterScrub'),
    audioBox: $('#audioBox'), audioBadge: $('#audioBadge'), audioTrack: $('#audioTrack'), audioOpts: $('#audioOpts'), audioMix: $('#audioMix'),
    audioVolume: $('#audioVolume'), audioVolumeVal: $('#audioVolumeVal'), audioLoop: $('#audioLoop'), audioList: $('#audioList'),
    audioAdd: $('#audioAdd'), audioNote: $('#audioNote'),
  };
  let watermark = null; // { name, thumb, id? } — the image itself is kept by the host (server upload / desktop path)

  el.preset.innerHTML = Object.entries(presets).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');

  const changed = () => { updateBadges(); onChange(); };
  [el.trimStart, el.trimEnd, el.posterTime].forEach((i) => i.addEventListener('input', changed));
  [el.hold, el.fadeDuration, el.wmPos, el.wmSize, el.wmOpacity].forEach((s) => s.addEventListener('change', changed));
  // Opacity slider: update its % label and filled track while dragging.
  const showOpacity = () => {
    const v = +el.wmOpacity.value, min = +el.wmOpacity.min, max = +el.wmOpacity.max;
    el.wmOpacityVal.textContent = `${Math.round(v * 100)}%`;
    el.wmOpacity.style.setProperty('--pct', `${((v - min) / (max - min)) * 100}%`);
    el.wmThumb.style.setProperty('--wm-op', String(v)); // the logo preview fades with the slider
    el.pp?.querySelector('.pp-wm')?.style.setProperty('opacity', String(v)); // and so does the overlay on the poster preview
  };
  el.wmOpacity.addEventListener('input', showOpacity);
  [el.fadeIn, el.fadeOut, el.posterOn].forEach((b) => b.addEventListener('click', () => { setSwitch(b, !isOn(b)); changed(); }));
  el.wmOn.addEventListener('click', async () => {
    setSwitch(el.wmOn, !isOn(el.wmOn));
    if (isOn(el.wmOn) && !watermark) await onChooseWatermark();
    if (!watermark) setSwitch(el.wmOn, false);
    changed();
  });
  el.wmChoose.addEventListener('click', async () => { await onChooseWatermark(); if (watermark) setSwitch(el.wmOn, true); changed(); });

  // Poster frame: the scrubber, the number field and a click on the timeline's video lane all set the same time.
  const setPosterTime = (t) => { el.posterTime.value = String(Math.round(t * 10) / 10); };
  el.scrub?.addEventListener('input', () => { setPosterTime(+el.scrub.value); changed(); });
  el.timeline?.querySelector('.tl-out .tl-track')?.addEventListener('click', (e) => {
    if (!tlState) return;
    const r = e.currentTarget.getBoundingClientRect();
    const out = (e.clientX - r.left) / r.width * tlState.span - tlState.start;
    if (out < 0 || out > tlState.total) return;
    setPosterTime(out);
    setSwitch(el.posterOn, true);
    changed();
  });

  function updateBadges() {
    const o = read();
    // Trim badge: the kept range, e.g. "2–12 s", "from 2 s", "to 12 s"
    const ts = o.trimStart > 0, te = o.trimEnd !== 'auto';
    el.trimBadge.textContent = ts && te ? `${o.trimStart}–${o.trimEnd} s` : ts ? `from ${o.trimStart} s` : te ? `to ${o.trimEnd} s` : '';
    const f = [];
    if (o.hold) f.push(`+${o.hold}s`);
    if (o.fadeIn || o.fadeOut) f.push('fade');
    el.finishBadge.textContent = f.join(', ');
    el.wmBadge.textContent = o.watermark?.enabled ? 'on' : '';
    el.posterBadge.textContent = o.poster ? 'on' : '';
    updateAudioPanel(o);
    el.wmBox.classList.toggle('wm-off', !isOn(el.wmOn));
  }

  function read() {
    const ts = num(el.trimStart), te = num(el.trimEnd), pt = num(el.posterTime);
    return {
      trimStart: ts && ts > 0 ? ts : 0,
      trimEnd: te && te > 0 ? te : 'auto',
      hold: +el.hold.value,
      fadeIn: isOn(el.fadeIn), fadeOut: isOn(el.fadeOut), fadeDuration: +el.fadeDuration.value,
      poster: isOn(el.posterOn), posterTime: pt == null ? 'auto' : pt,
      watermark: isOn(el.wmOn) && watermark
        ? { enabled: true, position: el.wmPos.value, size: +el.wmSize.value, opacity: +el.wmOpacity.value, id: watermark.id }
        : { enabled: false },
      audio: readAudio(),
    };
  }

  function apply(o = {}) {
    // 0 / 'auto' clear the field (otherwise an old trim would stick)
    if ('trimStart' in o) el.trimStart.value = o.trimStart > 0 ? o.trimStart : '';
    if ('trimEnd' in o) el.trimEnd.value = o.trimEnd && o.trimEnd !== 'auto' ? o.trimEnd : '';
    const pick = (sel, v) => { if (v != null && [...sel.options].some((x) => x.value === String(v))) sel.value = String(v); };
    pick(el.hold, o.hold); pick(el.fadeDuration, o.fadeDuration);
    if (o.fadeIn != null) setSwitch(el.fadeIn, o.fadeIn);
    if (o.fadeOut != null) setSwitch(el.fadeOut, o.fadeOut);
    if (o.poster != null) setSwitch(el.posterOn, o.poster);
    if ('posterTime' in o) el.posterTime.value = o.posterTime != null && o.posterTime !== 'auto' ? o.posterTime : '';
    if (o.watermark) {
      pick(el.wmPos, o.watermark.position); pick(el.wmSize, o.watermark.size);
      if (o.watermark.opacity != null && isFinite(+o.watermark.opacity)) el.wmOpacity.value = Math.max(0.1, Math.min(1, +o.watermark.opacity));
    }
    if ('audio' in o) applyAudio(o.audio);
    showOpacity();
    updateBadges();
  }

  // ---- soundtrack: a library of audio files (kept by the host) and the track chosen for the video
  let audioLib = [], pendingTrack = null, lastTotal = null;
  const fmtLen = (d) => (d == null ? '' : d >= 60 ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}` : `${d.toFixed(1)} s`);
  const audioById = (id) => audioLib.find((a) => a.id === id);
  function readAudio() {
    const track = el.audioTrack?.value || 'artifact';
    if (track === 'artifact' || !audioById(track)) return { track: 'artifact' };
    return { track, mix: el.audioMix.value, volume: +el.audioVolume.value, loop: isOn(el.audioLoop) };
  }
  function applyAudio(a) {
    if (!el.audioTrack) return;
    const track = a && a.track && a.track !== 'artifact' ? a.track : 'artifact';
    // the library may arrive after the settings (web: uploads; desktop: init), so remember the choice
    pendingTrack = track !== 'artifact' && !audioById(track) ? track : null;
    el.audioTrack.value = pendingTrack ? 'artifact' : track;
    if (a) {
      if (a.mix === 'mix' || a.mix === 'replace') el.audioMix.value = a.mix;
      if (a.volume != null && isFinite(+a.volume)) el.audioVolume.value = String(Math.max(0, Math.min(1, +a.volume)));
      if (a.loop != null) setSwitch(el.audioLoop, !!a.loop);
    }
    showVolume();
  }
  function showVolume() {
    if (!el.audioVolume) return;
    const v = +el.audioVolume.value;
    el.audioVolumeVal.textContent = `${Math.round(v * 100)}%`;
    el.audioVolume.style.setProperty('--pct', `${v * 100}%`);
  }
  function setAudioLibrary(list) {
    if (!el.audioTrack) return;
    const keep = el.audioTrack.value;
    audioLib = (list || []).map((a) => ({ id: String(a.id), name: String(a.name || 'Audio'), duration: a.duration ?? null }));
    const own = new Option("The artifact's own sound", 'artifact');
    el.audioTrack.replaceChildren(own, ...audioLib.map((a) => new Option(a.duration != null ? `${a.name} (${fmtLen(a.duration)})` : a.name, a.id)));
    const want = pendingTrack && audioById(pendingTrack) ? pendingTrack : keep;
    el.audioTrack.value = audioById(want) ? want : 'artifact';
    if (pendingTrack && audioById(pendingTrack)) pendingTrack = null;
    const rows = audioLib.map((a) => {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'au-name'; name.textContent = a.name; name.title = a.name;
      const len = document.createElement('span'); len.className = 'au-len mono'; len.textContent = fmtLen(a.duration);
      const use = document.createElement('button'); use.type = 'button'; use.className = 'link au-use'; use.textContent = 'Use';
      use.addEventListener('click', () => { el.audioTrack.value = a.id; pendingTrack = null; changed(); });
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'au-rm'; rm.textContent = '×';
      rm.title = 'Remove from the list'; rm.setAttribute('aria-label', `Remove ${a.name}`);
      rm.addEventListener('click', async () => { await onRemoveAudio?.(a.id); });
      li.dataset.id = a.id;
      li.append(name, len, use, rm);
      return li;
    });
    if (!rows.length) {
      const li = document.createElement('li'); li.className = 'au-empty';
      li.textContent = 'No audio files yet. Add MP3, WAV, M4A, AAC, OGG, FLAC or Opus files, then pick one as the track.';
      rows.push(li);
    }
    el.audioList.replaceChildren(...rows);
    changed();
  }
  function updateAudioPanel(o) {
    if (!el.audioTrack) return;
    const a = o.audio, custom = a.track !== 'artifact', st = soundState();
    el.audioOpts.hidden = !custom;
    for (const li of el.audioList.children) li.classList.toggle('active', li.dataset.id === a.track);
    const f = custom ? audioById(a.track) : null;
    el.audioBadge.textContent = !custom || st !== 'on' ? '' : a.mix === 'mix' ? 'mixed' : 'custom';
    let note = '';
    if (custom && st === 'gif') note = 'GIF files have no sound, so the track is not used.';
    else if (custom && st === 'off') note = 'Sound is off, so the video will be silent. Turn on Sound to use this track.';
    else if (custom && f?.duration != null && !a.loop && lastTotal && f.duration < lastTotal - 0.05) note = `The track is ${fmtLen(f.duration)} long, the video ${fmtLen(lastTotal)}: the rest is silent unless Loop is on.`;
    el.audioNote.textContent = note;
    el.audioNote.hidden = !note;
  }
  if (el.audioTrack) {
    el.audioTrack.addEventListener('change', () => { pendingTrack = null; changed(); });
    el.audioMix.addEventListener('change', changed);
    el.audioVolume.addEventListener('input', showVolume);
    el.audioVolume.addEventListener('change', changed);
    el.audioLoop.addEventListener('click', () => { setSwitch(el.audioLoop, !isOn(el.audioLoop)); changed(); });
    el.audioAdd.addEventListener('click', async () => {
      if (!onAddAudio) return;
      el.audioAdd.disabled = true;
      try {
        const added = await onAddAudio();
        // the first file added becomes the track if the artifact's own sound was in use
        if (added?.length && el.audioTrack.value === 'artifact' && audioById(added[0])) { el.audioTrack.value = added[0]; changed(); }
      } finally { el.audioAdd.disabled = false; }
    });
    showVolume();
  }

  function setWatermark(w, { enable = true } = {}) {
    watermark = w;
    el.wmName.textContent = w ? w.name : 'No image chosen';
    el.wmThumb.style.setProperty('--wm-img', w?.thumb ? `url("${w.thumb}")` : 'none');
    if (w && enable) setSwitch(el.wmOn, true);
    if (!w) setSwitch(el.wmOn, false);
    // the logo's shape decides its height in the video, so read it from the image
    wmAspect = null;
    if (w?.thumb) {
      const im = new Image();
      im.onload = () => { if (watermark === w && im.naturalWidth) { wmAspect = im.naturalHeight / im.naturalWidth; updateSizeLabels(); } };
      im.src = w.thumb;
    }
    updateSizeLabels();
    updateBadges();
  }

  // ---- watermark size labels: "Medium (230 × 77 px)" for the current output size and logo. Same maths
  // as the encoder (encode.js finalize): width = share of the video width, rounded to even, min 16 px;
  // height follows the logo's aspect ratio.
  let outSize = null, wmAspect = null;
  const sizeNames = new Map([...el.wmSize.options].map((o) => [o.value, o.textContent.trim()]));
  function updateSizeLabels() {
    for (const opt of el.wmSize.options) {
      const name = sizeNames.get(opt.value) || opt.value;
      if (!outSize) { opt.textContent = name; continue; }
      const w = Math.max(16, Math.round(outSize.w * +opt.value / 2) * 2);
      opt.textContent = wmAspect ? `${name} (${w} × ${Math.round(w * wmAspect)} px)` : `${name} (${w} px wide)`;
    }
  }
  function setOutputSize(w, h) {
    if (outSize && outSize.w === w && outSize.h === h) return;
    outSize = { w, h };
    updateSizeLabels();
  }

  // Which preset matches the current fields? (anything else → "Custom")
  function syncPreset(fields) {
    const match = Object.entries(presets).find(([id, p]) => id !== 'custom'
      && presetFields.every((k) => p[k] === undefined || String(p[k]) === String(fields[k])));
    el.preset.value = match ? match[0] : 'custom';
  }
  function onPreset(handler) {
    el.preset.addEventListener('change', () => { const p = presets[el.preset.value]; if (p && el.preset.value !== 'custom') handler(p); });
  }

  // Length of the finished video, and a validation message if the trim doesn't fit the animation.
  // `over` lets a host check another artifact's own trim, e.g. { trimStart, trimEnd, posterTime }.
  function timing(duration, over = null) {
    const o = over ? { ...read(), ...over } : read();
    if (!duration) return { clip: null, total: null, error: null };
    const start = Math.min(o.trimStart, duration);
    const end = o.trimEnd === 'auto' ? duration : Math.min(o.trimEnd, duration);
    let error = null;
    if (o.trimStart >= duration) error = `"Start at" must be less than the animation length (${duration.toFixed(1)} s).`;
    else if (o.trimEnd !== 'auto' && o.trimEnd <= o.trimStart) error = '"End at" must be after "Start at".';
    const clip = Math.max(0, end - start);
    return { clip, total: clip + o.hold, start, end, error };
  }

  function summaryParts(duration) {
    const o = read(), t = timing(duration), parts = [];
    if (t.clip != null && (o.trimStart > 0 || o.trimEnd !== 'auto')) parts.push(`${t.start.toFixed(1)}–${t.end.toFixed(1)} s`);
    if (o.hold) parts.push(`+${o.hold} s hold`);
    if (o.fadeIn || o.fadeOut) parts.push(o.fadeIn && o.fadeOut ? 'fade in/out' : o.fadeIn ? 'fade in' : 'fade out');
    if (o.watermark.enabled) parts.push('watermark');
    if (o.audio.track !== 'artifact' && soundState() === 'on') parts.push(o.audio.mix === 'mix' ? 'mixed soundtrack' : 'custom soundtrack');
    if (o.poster) parts.push('+ poster PNG');
    return parts;
  }

  showOpacity();
  // ---- output timeline: source lane (green window = trim) above the video lane (clip, held frame,
  // fades, poster pin), both on one time scale. Built with CSSOM only (the desktop CSP forbids
  // inline style attributes).
  const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };
  function drawTimeline(duration, fps, { emptyText = 'Add an artifact to see what the video will contain', label = 'Output' } = {}) {
    const tl = el.timeline;
    if (!tl) return;
    const q = (c) => tl.querySelector(c);
    q('.tl-head strong').textContent = label;
    const total = q('.tl-total'), msg = q('.tl-msg');
    const t = timing(duration);
    tl.classList.toggle('tl-none', !t.clip);
    tl.classList.toggle('tl-error', !!t.error);
    lastTotal = t.total;
    if (!t.clip) { total.textContent = ''; msg.textContent = t.error || emptyText; tlState = null; updatePoster(duration, fps); updateTrimFrames(duration, fps); updateBadges(); return; }
    const o = read();
    const span = Math.max(duration, t.end + o.hold);
    tlState = { span, start: t.start, total: t.total };
    const pct = (v) => `${(Math.max(0, v) / span) * 100}%`;
    const place = (node, from, len) => { node.style.left = pct(from); node.style.width = pct(len); node.hidden = len <= 0; };
    place(q('.tl-win'), t.start, t.clip);
    place(q('.tl-clip'), t.start, t.clip);
    place(q('.tl-hold'), t.end, o.hold);
    place(q('.tl-body'), 0, duration);
    const fd = Math.min(o.fadeDuration, t.total / 2);
    place(q('.tl-fi'), t.start, o.fadeIn ? fd : 0);
    place(q('.tl-fo'), t.end + o.hold - fd, o.fadeOut ? fd : 0);
    const pin = q('.tl-poster');
    pin.hidden = !o.poster;
    pin.style.left = pct(t.start + Math.min(o.posterTime === 'auto' ? t.clip / 2 : o.posterTime, t.total));
    // audio lane: a custom track starts with the video; looped, it repeats (a tick at every restart)
    const aud = q('.tl-aud'), af = o.audio.track !== 'artifact' && soundState() === 'on' ? audioById(o.audio.track) : null;
    if (aud) {
      aud.hidden = !af;
      if (af) {
        const len = af.duration == null || o.audio.loop ? t.total : Math.min(af.duration, t.total);
        const snd = q('.tl-snd');
        place(snd, t.start, len);
        snd.classList.toggle('mixed', o.audio.mix === 'mix');
        snd.style.setProperty('--seg', o.audio.loop && af.duration && af.duration < t.total ? `${(af.duration / len) * 100}%` : '100%');
        place(q('.tl-afi'), t.start, o.fadeIn ? fd : 0);
        place(q('.tl-afo'), t.end + o.hold - fd, o.fadeOut && len >= t.total - 0.01 ? fd : 0);
        aud.title = `${af.name}${o.audio.mix === 'mix' ? ', mixed with the artifact\'s sound' : ''}`;
      }
    }
    // scale: in point, out point, and the end of the source / held frame; drop labels that would collide
    const marks = [[q('.tl-in'), t.start], [q('.tl-out-t'), t.end], [q('.tl-end'), span]];
    let last = -1;
    for (const [node, v] of marks) {
      const x = (v / span) * 100;
      const show = x - last > 14 || last < 0;
      node.hidden = !show;
      if (!show) continue;
      last = x;
      node.textContent = v === span && o.hold && v !== t.end ? `+${o.hold} s` : fmt(v);
      node.style.left = `${x}%`;
      node.className = `${node.className.split(' ')[0]}${x < 6 ? ' at-start' : x > 94 ? ' at-end' : ''}`;
    }
    const frames = Math.round(t.clip * fps);
    total.innerHTML = '';
    const b = document.createElement('b'); b.textContent = `${t.total.toFixed(1)} s`;
    const sm = document.createElement('span'); sm.textContent = `${frames.toLocaleString()} frames captured`;
    total.append(b, sm);
    const notes = [];
    if (o.trimStart > 0 || o.trimEnd !== 'auto') notes.push(`${fmt(t.start)} to ${fmt(t.end)} of ${fmt(duration)}`);
    if (o.hold) notes.push(`last frame held ${o.hold} s`);
    if (o.fadeIn || o.fadeOut) notes.push(o.fadeIn && o.fadeOut ? 'fades in and out' : o.fadeIn ? 'fades in' : 'fades out');
    if (o.poster) notes.push('poster frame marked');
    if (af) notes.push(`soundtrack: ${af.name}`);
    msg.textContent = t.error || (notes.length ? notes.join(', ') : 'The whole animation, no trim');
    updatePoster(duration, fps);
    updateTrimFrames(duration, fps);
    updateBadges();
  }

  // ---- frame previews (poster frame, trim start, trim end). One shared queue: one render at a time,
  // newest request first, stale requests dropped, rendered frames cached (the same moment is never
  // rendered twice, e.g. the poster at the trim start).
  let tlState = null;
  const pv = { busy: false, timer: 0, last: null, ratio: 16 / 9, cache: new Map() };
  const slots = new Map(); // name -> { root, open: () => bool, key, want, ts }
  const addSlot = (name, root, open) => { if (root) slots.set(name, { root, open, key: null, want: null, ts: 0 }); };
  addSlot('poster', el.pp, () => !!el.posterBox?.open);
  addSlot('trimStart', $('#trimStartFrame'), () => !!$('#trimBox')?.open);
  addSlot('trimEnd', $('#trimEndFrame'), () => !!$('#trimBox')?.open);
  const sq = (name, c) => slots.get(name)?.root.querySelector(c);
  const pq = (c) => sq('poster', c);
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  function showFrame(name, src) {
    const img = sq(name, '.pp-img');
    if (img.getAttribute('src') !== src) img.src = src;
    img.hidden = false; sq(name, '.pp-msg').textContent = '';
  }
  function slotIdle(name, text) {
    const s = slots.get(name);
    if (!s) return;
    s.want = null; s.key = null;
    sq(name, '.pp-img').hidden = true; sq(name, '.pp-msg').textContent = text;
  }
  // want = { key, anim } (anim = seconds into the artifact's animation)
  function requestFrame(name, want) {
    const s = slots.get(name);
    if (!s) return;
    s.want = want; s.ts = performance.now();
    if (pv.cache.has(want.key)) { s.key = want.key; showFrame(name, pv.cache.get(want.key)); return; }
    if (!s.open() || want.key === s.key) return;
    if (sq(name, '.pp-img').hidden) sq(name, '.pp-msg').textContent = 'Rendering preview…';
    clearTimeout(pv.timer);
    pv.timer = setTimeout(pump, 250);
  }
  async function pump() {
    if (pv.busy) return;
    const next = [...slots.entries()].filter(([, s]) => s.want && s.want.key !== s.key && s.open()).sort((a, b) => b[1].ts - a[1].ts)[0];
    if (!next) return;
    const [name, s] = next, want = s.want, spin = sq(name, '.pp-spin');
    pv.busy = true; spin.hidden = false;
    try {
      const src = pv.cache.get(want.key) || await previewFrame(want.anim);
      if (src) {
        pv.cache.set(want.key, src);
        if (pv.cache.size > 40) pv.cache.delete(pv.cache.keys().next().value);
        // any other slot waiting for the same moment gets it too
        for (const [n, o] of slots) if (o.want?.key === want.key) { o.key = want.key; showFrame(n, src); }
      }
    } catch (e) {
      sq(name, '.pp-img').hidden = true; sq(name, '.pp-msg').textContent = errText(e);
    } finally {
      s.key = want.key; pv.busy = false; spin.hidden = true;
      pump();
    }
  }
  el.posterBox?.addEventListener('toggle', () => { if (el.posterBox.open && pv.last) updatePoster(...pv.last); });
  $('#trimBox')?.addEventListener('toggle', () => { if ($('#trimBox').open && pv.last) updateTrimFrames(...pv.last); });

  // ---- poster preview: the chosen frame, dimmed like the fades would, with the watermark overlaid
  pq('.pp-img')?.addEventListener('load', (e) => {
    const { naturalWidth: w, naturalHeight: h } = e.target;
    if (w && h) { pv.ratio = w / h; pq('.pp-frame').style.aspectRatio = `${w} / ${h}`; updateWm(read()); }
  });
  function updateWm(o) {
    const wm = pq('.pp-wm');
    if (!wm) return;
    if (!o.watermark.enabled || !watermark?.thumb) { wm.hidden = true; return; }
    if (wm.getAttribute('src') !== watermark.thumb) wm.src = watermark.thumb;
    wm.hidden = false;
    wm.style.width = `${o.watermark.size * 100}%`;
    wm.style.opacity = String(o.watermark.opacity);
    // same margin as the encoder: 4% of the shorter side
    const r = pv.ratio, mx = r >= 1 ? 4 / r : 4, my = r >= 1 ? 4 : 4 * r;
    const pos = o.watermark.position;
    Object.assign(wm.style, { left: '', right: '', top: '', bottom: '', transform: '' });
    if (pos === 'center') Object.assign(wm.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
    else {
      wm.style[pos.includes('l') ? 'left' : 'right'] = `${mx}%`;
      wm.style[pos.includes('t') ? 'top' : 'bottom'] = `${my}%`;
    }
  }
  // Round to ms: unrounded floats (0.9666…67 vs a max of 0.966…7) made range inputs "invalid",
  // which once silently blocked the form's submit.
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const frameKey = (fps, anim) => `${previewKey()}|${fps}|${anim.toFixed(4)}`;
  function updatePoster(duration, fps) {
    if (!el.pp) return;
    pv.last = [duration, fps];
    const t = timing(duration), o = read();
    const img = pq('.pp-img');
    if (!previewFrame || !t.clip || t.error) {
      el.scrub.disabled = true;
      slotIdle('poster', t.error ? 'Fix the trim to preview the poster frame' : 'Add an artifact to preview the poster frame');
      updateWm(o);
      return;
    }
    const step = 1 / fps;
    const maxT = r3(Math.max(step, t.total - step));
    const outT = Math.max(0, Math.min(r3(o.posterTime === 'auto' ? t.clip / 2 : o.posterTime), maxT));
    el.scrub.disabled = false;
    el.scrub.max = String(maxT);
    el.scrub.step = 'any';
    if (document.activeElement !== el.scrub) el.scrub.value = String(outT);
    el.scrub.style.setProperty('--pct', `${(outT / maxT) * 100}%`);
    // fades darken the poster too
    const fd = Math.min(o.fadeDuration, t.total / 2);
    let b = 1;
    if (o.fadeIn && outT < fd) b = Math.min(b, outT / fd);
    if (o.fadeOut && outT > t.total - fd) b = Math.min(b, (t.total - outT) / fd);
    img.style.filter = b < 1 ? `brightness(${b.toFixed(3)})` : '';
    updateWm(o);
    // a time inside the held last frame shows the last frame
    const anim = Math.round((t.start + Math.min(outT, t.clip - step)) * fps) / fps;
    requestFrame('poster', { key: frameKey(fps, anim), anim });
  }

  // ---- trim frames: the first and the last frame the video will contain, each with a slider
  const tsScrub = $('#trimStartScrub'), teScrub = $('#trimEndScrub');
  const trimFmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`; };
  tsScrub?.addEventListener('input', () => { el.trimStart.value = String(Math.round(+tsScrub.value * 10) / 10 || ''); changed(); });
  teScrub?.addEventListener('input', () => {
    const v = Math.round(+teScrub.value * 10) / 10;
    el.trimEnd.value = pv.last && v >= pv.last[0] ? '' : String(v); // dragged to the very end = no end trim
    changed();
  });
  function updateTrimFrames(duration, fps) {
    if (!slots.has('trimStart')) return;
    const t = timing(duration);
    for (const sc of [tsScrub, teScrub]) sc.disabled = !t.clip && !t.error;
    if (!previewFrame || !duration) {
      for (const n of ['trimStart', 'trimEnd']) slotIdle(n, 'Add an artifact to see its frames');
      for (const n of ['trimStart', 'trimEnd']) sq(n, '.tf-time').textContent = '';
      return;
    }
    const D = r3(duration), o = read();
    for (const [sc, v] of [[tsScrub, Math.min(o.trimStart, D)], [teScrub, o.trimEnd === 'auto' ? D : Math.min(o.trimEnd, D)]]) {
      sc.max = String(D); sc.step = 'any';
      if (document.activeElement !== sc) sc.value = String(r3(v));
      sc.style.setProperty('--pct', `${(Math.min(+sc.value, D) / D) * 100}%`);
    }
    if (t.error) {
      for (const n of ['trimStart', 'trimEnd']) { slotIdle(n, 'Check Start at and End at'); sq(n, '.tf-time').textContent = ''; }
      return;
    }
    // first captured frame, and the last one (the frame just before End at)
    const first = Math.round(t.start * fps) / fps;
    const last = Math.max(first, Math.round(t.end * fps) / fps - 1 / fps);
    sq('trimStart', '.tf-time').textContent = trimFmt(first);
    sq('trimEnd', '.tf-time').textContent = trimFmt(last);
    requestFrame('trimStart', { key: frameKey(fps, first), anim: first });
    requestFrame('trimEnd', { key: frameKey(fps, last), anim: last });
  }

  // Short spec line under the timeline (one span per item, no separators in the text).
  function setSummary(parts) {
    if (!el.summary) return;
    el.summary.replaceChildren(...parts.filter(Boolean).map((p) => { const s = document.createElement('span'); s.textContent = p; return s; }));
  }

  updateBadges();
  return { read, apply, setWatermark, setAudioLibrary, setOutputSize, syncPreset, onPreset, timing, summaryParts, drawTimeline, setSummary, el };
}
