// Runs inside the artifact page before any of its own scripts (Playwright addInitScript).
// Installs:
//   1. A virtual clock: performance.now / Date / rAF / timers / CSS+WAAPI animations / <video>
//      run in real time while the page loads, then freeze and advance only when the renderer
//      says so (one exact step per video frame).
//   2. An audio shim: every `new AudioContext()` becomes an OfflineAudioContext whose
//      currentTime follows the virtual clock. Whatever the page schedules is rendered offline
//      at the end, so the soundtrack is sample-exact with the picture.
//   3. <audio>/<video> playback logging so media-element sound can be mixed in by FFmpeg.
// Everything is exposed on window.__a2v for the renderer.

export function initScript(cfg) {
  /* eslint-disable */
  (function () {
    if (window.__a2v) return;
    const C = cfg;
    const realPerfNow = performance.now.bind(performance);
    const RealDate = Date;
    const realDateNow = Date.now;
    const nRAF = window.requestAnimationFrame.bind(window);
    const nCAF = window.cancelAnimationFrame.bind(window);
    const nST = window.setTimeout.bind(window);
    const nCT = window.clearTimeout.bind(window);
    const nSI = window.setInterval.bind(window);
    const nCI = window.clearInterval.bind(window);

    // Deterministic Math.random so parallel render workers see the exact same animation.
    if (C.seed != null) {
      let a = C.seed >>> 0;
      Math.random = function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    // Remember which canvas contexts the page asks for: WebGL artifacts draw on the CPU when there's
    // no graphics card (SwiftShader), which can be 100× slower, and a failed WebGL context explains a
    // blank or broken artifact.
    const ctxKinds = new Set(), ctxFailed = new Set();
    const wrapGetContext = (proto) => {
      if (!proto || !proto.getContext) return;
      const orig = proto.getContext;
      proto.getContext = function (type, ...rest) {
        const r = orig.call(this, type, ...rest);
        (r ? ctxKinds : ctxFailed).add(String(type));
        return r;
      };
    };
    wrapGetContext(window.HTMLCanvasElement && HTMLCanvasElement.prototype);
    wrapGetContext(window.OffscreenCanvas && OffscreenCanvas.prototype);

    let frozen = false;
    let vNow = 0;          // virtual performance.now() in ms
    let dateBase = 0;      // Date.now() at freeze minus vNow at freeze
    let captureStart = 0;  // vNow at frame 0 (audio t=0)
    let captureStarted = false;

    const timers = new Map();
    let timerSeq = 1e7;
    let rafs = new Map();
    let rafSeq = 1e7;

    // While frozen, each read nudges the clock by 0.1 µs (reset every frame) so busy-wait loops
    // like `while (performance.now() < end) {}` still terminate instead of hanging the page.
    let nudge = 0;
    performance.now = function () { return frozen ? vNow + (nudge += 1e-4) : realPerfNow(); };
    Date.now = function () { return frozen ? Math.floor(dateBase + vNow + (nudge += 1e-4)) : realDateNow(); };
    function VDate(...a) {
      if (!new.target) return new RealDate(Date.now()).toString();
      return a.length ? new RealDate(...a) : new RealDate(Date.now());
    }
    VDate.prototype = RealDate.prototype;
    VDate.now = Date.now; VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
    window.Date = VDate;

    window.setTimeout = function (fn, d, ...args) {
      if (!frozen) return nST(fn, d, ...args);
      const id = timerSeq++;
      timers.set(id, { fn, at: vNow + Math.max(0, +d || 0), args, every: 0 });
      return id;
    };
    window.setInterval = function (fn, d, ...args) {
      if (!frozen) return nSI(fn, d, ...args);
      const id = timerSeq++;
      const every = Math.max(1, +d || 0);
      timers.set(id, { fn, at: vNow + every, args, every });
      return id;
    };
    window.clearTimeout = function (id) { if (timers.has(id)) timers.delete(id); else nCT(id); };
    window.clearInterval = function (id) { if (timers.has(id)) timers.delete(id); else nCI(id); };
    window.requestAnimationFrame = function (cb) {
      if (!frozen) return nRAF(cb);
      const id = rafSeq++; rafs.set(id, cb); return id;
    };
    window.cancelAnimationFrame = function (id) { if (rafs.has(id)) rafs.delete(id); else nCAF(id); };

    // ---- CSS / Web Animations + <video>: drive currentTime from the virtual clock ----
    const animState = new WeakMap();
    function syncAnimations() {
      let list = [];
      try { list = document.getAnimations(); } catch (e) {}
      for (const a of list) {
        let s = animState.get(a);
        if (!s) {
          s = { base: +a.currentTime || 0, v0: vNow };
          animState.set(a, s);
          try { a.pause(); } catch (e) {}
        }
        try { a.currentTime = s.base + (vNow - s.v0) * (a.playbackRate || 1); } catch (e) {}
      }
      document.querySelectorAll('video').forEach(function (v) {
        if (!v.__a2v) { v.__a2v = { base: v.currentTime || 0, v0: vNow, playing: !v.paused }; try { v.pause(); } catch (e) {} }
        const s = v.__a2v;
        if (s.playing && v.readyState >= 1) {
          let t = s.base + (vNow - s.v0) / 1000 * (v.playbackRate || 1);
          if (v.loop && v.duration) t = t % v.duration;
          try { v.currentTime = t; } catch (e) {}
        }
      });
    }

    // ---- Audio: AudioContext -> OfflineAudioContext on the virtual timeline ----
    const SR = C.sampleRate || 48000;
    const shims = [];
    const NativeOffline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const audioSeconds = () => (captureStarted ? Math.max(0, (vNow - captureStart) / 1000) : 0);
    let ShimCtx = null;
    // Always shimmed (even when sound is off) so audio-clocked players follow the virtual clock.
    if (NativeOffline) {
      ShimCtx = class AudioContext extends NativeOffline {
        constructor() {
          super({ numberOfChannels: 2, length: Math.ceil(SR * C.audioSeconds), sampleRate: SR });
          shims.push(this);
          this.__state = 'running';
          this.onstatechange = null;
        }
        get currentTime() { return audioSeconds(); }
        get state() { return this.__state; }
        get baseLatency() { return 0; }
        get outputLatency() { return 0; }
        resume() { this.__state = 'running'; return Promise.resolve(); }
        suspend() { return Promise.resolve(); }
        close() { this.__state = 'closed'; return Promise.resolve(); }
        getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now() }; }
        createMediaElementSource(el) { return this.createGain(); }
        createMediaStreamSource() { return this.createGain(); }
        createMediaStreamDestination() { const g = this.createGain(); g.stream = new MediaStream(); return g; }
        startRendering() { return Promise.reject(new Error('not available')); }
      };
      const nStartRendering = NativeOffline.prototype.startRendering;
      ShimCtx.prototype.__render = function () { return nStartRendering.call(this); };
      if (C.fakeOfflineAudio) {
        // Sound is off: page-made OfflineAudioContexts "render" instantly to silence.
        NativeOffline.prototype.startRendering = function () {
          const buf = this.createBuffer(Math.max(1, this.destination.channelCount || 2), Math.max(1, this.length || 1), this.sampleRate);
          setTimeout(() => {
            try { this.dispatchEvent(new OfflineAudioCompletionEvent('complete', { renderedBuffer: buf })); } catch (e) {}
          }, 0);
          return Promise.resolve(buf);
        };
      }
      window.AudioContext = ShimCtx;
      window.webkitAudioContext = ShimCtx;
      // start(0)/start() mean "now": move them to the virtual now on shim contexts.
      const SN = window.AudioScheduledSourceNode && AudioScheduledSourceNode.prototype;
      if (SN) {
        const nStart = SN.start, nStop = SN.stop;
        const fix = (ctx, w) => Math.max(+w || 0, ctx.currentTime);
        SN.start = function (when, ...rest) {
          if (this.context instanceof ShimCtx) return nStart.call(this, fix(this.context, when), ...rest);
          return nStart.call(this, when, ...rest);
        };
        SN.stop = function (when) {
          if (this.context instanceof ShimCtx) return nStop.call(this, fix(this.context, when));
          return nStop.call(this, when);
        };
      }
      // param.value = x at virtual time t  ->  setValueAtTime(x, t)
      const ownerCtx = new WeakMap();
      const nodeProto = AudioNode.prototype;
      const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
      if (desc && desc.set) {
        Object.defineProperty(AudioParam.prototype, 'value', {
          get: desc.get,
          set(v) {
            const ctx = ownerCtx.get(this);
            if (ctx && captureStarted) { try { this.cancelScheduledValues(ctx.currentTime); this.setValueAtTime(v, ctx.currentTime); return; } catch (e) {} }
            desc.set.call(this, v);
          },
          configurable: true,
        });
      }
      // The offline graph is only evaluated when rendering at the end, so a real disconnect()
      // would erase everything that node already "played". Every connection therefore goes
      // through a gate GainNode; connect/disconnect become gain automation at the virtual time.
      const nConnect = nodeProto.connect, nDisconnect = nodeProto.disconnect;
      nodeProto.connect = function (dest, output, input) {
        if (!(this.context instanceof ShimCtx) || this.__a2vGate) return nConnect.apply(this, arguments);
        if (!this.__a2vParams) {
          this.__a2vParams = true;
          for (const k in this) { try { if (this[k] instanceof AudioParam) ownerCtx.set(this[k], this.context); } catch (e) {} }
        }
        const ctx = this.context, t = ctx.currentTime;
        const gate = ctx.createGain();
        gate.__a2vGate = true;
        if (t > 0) { gate.gain.setValueAtTime(0, 0); gate.gain.setValueAtTime(1, t); }
        nConnect.call(this, gate, output || 0);
        if (dest instanceof AudioParam) nConnect.call(gate, dest);
        else nConnect.call(gate, dest, 0, input || 0);
        (this.__a2vConns || (this.__a2vConns = [])).push({ dest, output: output || 0, input: input || 0, gate });
        return dest instanceof AudioParam ? undefined : dest;
      };
      nodeProto.disconnect = function (a, b, c) {
        if (!(this.context instanceof ShimCtx) || this.__a2vGate) return nDisconnect.apply(this, arguments);
        const t = this.context.currentTime, keep = [];
        for (const k of this.__a2vConns || []) {
          const match = a === undefined ? true : typeof a === 'number' ? k.output === a
            : k.dest === a && (b === undefined || k.output === b) && (c === undefined || k.input === c);
          if (match) { k.gate.gain.cancelScheduledValues(t); k.gate.gain.setValueAtTime(0, t); } else keep.push(k);
        }
        this.__a2vConns = keep;
      };
    }

    // ---- <audio>/<video> elements: log what played and when ----
    const mediaLog = [];
    const nPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        if (captureStarted && this.tagName === 'AUDIO' || (captureStarted && this.tagName === 'VIDEO' && !this.muted)) {
          mediaLog.push({ src: this.currentSrc || this.src, at: audioSeconds(), offset: this.currentTime || 0,
            volume: this.muted ? 0 : this.volume, loop: !!this.loop, rate: this.playbackRate || 1 });
          const entry = mediaLog[mediaLog.length - 1];
          const el = this;
          el.__a2vEntry = entry;
        }
      } catch (e) {}
      const r = nPlay.call(this);
      return r && r.catch ? r.catch(function () {}) : r;
    };
    const nPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (this.__a2vEntry && this.__a2vEntry.end == null) this.__a2vEntry.end = audioSeconds();
      return nPause.call(this);
    };

    function runDue(target) {
      for (let guard = 0; guard < 10000; guard++) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        vNow = Math.max(vNow, t.at);
        if (t.every) t.at += t.every; else timers.delete(id);
        try { typeof t.fn === 'function' ? t.fn(...t.args) : (0, eval)(String(t.fn)); } catch (e) { console.error(e); }
      }
    }

    window.__a2v = Object.assign(window.__a2v || {}, {
      freeze() {
        if (frozen) return;
        vNow = realPerfNow();
        dateBase = realDateNow() - vNow;
        frozen = true;
        syncAnimations();
      },
      startCapture() { captureStart = vNow; captureStarted = true; },
      advance(ms) {
        nudge = 0;
        const target = vNow + ms;
        runDue(target);
        vNow = target;
        const cbs = rafs; rafs = new Map();
        for (const cb of cbs.values()) { try { cb(vNow); } catch (e) { console.error(e); } }
        syncAnimations();
      },
      // Move to frame index i, stepping one frame at a time from the current frame. Targets are
      // computed from the index, so every worker hits identical clock values.
      goTo(fps, i) {
        if (this.__frame == null) this.__frame = -1;
        for (let j = this.__frame + 1; j <= i; j++) this.advance(Math.max(0, captureStart + (j * 1000) / fps - vNow));
        if (i > this.__frame) this.__frame = i;
      },
      now() { return vNow; },
      contexts() { return { made: [...ctxKinds], failed: [...ctxFailed] }; },
      shimCount() { return shims.length; },
      media() { return mediaLog; },
      async renderAudio() {
        if (!shims.length) return null;
        const bufs = await Promise.all(shims.map((s) => s.__render()));
        const n = Math.min(Math.ceil(SR * C.trimSeconds), bufs[0].length);
        const L = new Float32Array(n), R = new Float32Array(n);
        let peak = 0;
        for (const b of bufs) {
          const l = b.getChannelData(0), r = b.numberOfChannels > 1 ? b.getChannelData(1) : l;
          for (let i = 0; i < n; i++) { L[i] += l[i]; R[i] += r[i]; }
        }
        for (let i = 0; i < n; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
        // 16-bit PCM WAV, base64 in chunks (renderer pulls them one by one)
        const pcm = new Int16Array(n * 2);
        for (let i = 0; i < n; i++) {
          pcm[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767;
          pcm[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
        }
        const bytes = new Uint8Array(pcm.buffer);
        const CH = 3 * 1024 * 1024;
        window.__a2vAudioChunks = [];
        for (let o = 0; o < bytes.length; o += CH) {
          let s = '';
          const sub = bytes.subarray(o, o + CH);
          for (let i = 0; i < sub.length; i += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(i, i + 0x8000));
          window.__a2vAudioChunks.push(btoa(s));
        }
        return { sampleRate: SR, frames: n, chunks: window.__a2vAudioChunks.length, peak, silent: peak < 1e-5 };
      },
    });
  })();
}
