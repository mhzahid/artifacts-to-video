import { spawn } from 'node:child_process';

// Resolved per call so a desktop shell can point it at a bundled binary after import.
const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';

// Video codec args for the frame pipe. GIF goes through a near-lossless H.264 intermediate.
// content: 'flat' (UI, text, vector shapes: most artifacts) or 'photo' (3D / WebGL scenes with soft
// light, film grain and dark gradients). '-tune animation' suits flat art but smooths grain away and
// leaves blocks in dark areas; 'photo' uses '-tune film' plus aq-mode 3, which spends bits in dark,
// flat regions (measured on a three.js reel: no visible blocking, files ~2× larger).
function videoArgs(format, quality, content = 'flat') {
  const q = { draft: 0, standard: 1, high: 2 }[quality] ?? 1;
  switch (format) {
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', ['38', '31', '24'][q], '-row-mt', '1',
        '-deadline', 'good', '-cpu-used', ['8', '4', '2'][q], '-pix_fmt', 'yuv420p',
        ...(content === 'photo' ? ['-tune-content', 'film', '-aq-mode', '2'] : [])];
    case 'mov':
      return ['-c:v', 'prores_ks', '-profile:v', ['0', '2', '3'][q], '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
    case 'gif':
    case 'intermediate': // near-lossless working copy, re-encoded once at the end (GIF, fades, hold, watermark)
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', quality === 'high' ? '6' : '10', '-pix_fmt', 'yuv444p'];
    case 'mp4':
    default:
      return ['-c:v', 'libx264', '-preset', ['veryfast', 'faster', 'medium'][q], '-crf', ['26', '20', '17'][q],
        '-pix_fmt', 'yuv420p', ...(content === 'photo' ? ['-tune', 'film', '-x264-params', 'aq-mode=3'] : ['-tune', 'animation'])];
  }
}

function audioArgs(format) {
  switch (format) {
    case 'webm': return ['-c:a', 'libopus', '-b:a', '160k'];
    case 'mov': return ['-c:a', 'pcm_s16le'];
    default: return ['-c:a', 'aac', '-b:a', '192k'];
  }
}

export function run(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const kill = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

// Reads an audio file's length with FFmpeg itself (ffprobe isn't bundled with ffmpeg-static).
// Resolves { duration (s), codec } or rejects if the file has no audio stream.
export function probeAudio(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 50000) err = err.slice(-50000); });
    const t = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('error', (e) => { clearTimeout(t); reject(ffmpegError(e, ffmpegBin())); });
    p.on('close', () => { // "ffmpeg -i" with no output always exits 1; the info is on stderr
      clearTimeout(t);
      const a = /Stream #[^\n]*?Audio: ([\w-]+)/.exec(err);
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (!a) return reject(new Error('That file has no audio FFmpeg can read. Use MP3, WAV, M4A, AAC, OGG, FLAC or Opus.'));
      resolve({ duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : null, codec: a[1] });
    });
  });
}

// Starts an ffmpeg process that reads images from stdin. Returns { write(buf), end() }.
export function startFramePipe({ fps, format, quality, imageFormat, out, width, height, signal, content = 'flat' }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-c:v', imageFormat === 'png' ? 'png' : 'mjpeg', '-framerate', String(fps), '-i', '-',
    '-vf', `scale=${width}:${height}:flags=lanczos,setsar=1`,
    ...videoArgs(format, quality, content), '-r', String(fps), '-an', out];
  const bin = ffmpegBin();
  const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  let failure = null; // set as soon as FFmpeg can't start or exits early
  p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
  const done = new Promise((resolve, reject) => {
    p.on('error', (e) => { failure = ffmpegError(e, bin); reject(failure); });
    p.on('close', (code) => {
      if (code === 0) return resolve();
      failure = failure || new Error(`FFmpeg stopped (exit ${code}): ${err.trim().split('\n').slice(-4).join(' | ') || 'no output'}`);
      reject(failure);
    });
  });
  done.catch(() => {});
  const kill = () => p.kill('SIGKILL');
  signal?.addEventListener('abort', kill, { once: true });
  p.stdin.on('error', () => {});
  return {
    // Never waits forever: if FFmpeg dies, the pending write rejects with FFmpeg's own error.
    write(buf) {
      if (failure) return Promise.reject(failure);
      if (p.stdin.write(buf)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onGone = () => { cleanup(); setImmediate(() => reject(failure || new Error('FFmpeg closed its input unexpectedly.'))); };
        const cleanup = () => { p.stdin.off('drain', onDrain); p.off('close', onGone); p.off('error', onGone); };
        p.stdin.once('drain', onDrain);
        p.once('close', onGone);
        p.once('error', onGone);
      });
    },
    async end() { p.stdin.end(); await done; signal?.removeEventListener('abort', kill); },
  };
}

function ffmpegError(e, bin) {
  if (e.code === 'ENOENT') return new Error(`FFmpeg was not found at "${bin}".`);
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'UNKNOWN') return new Error(`FFmpeg at "${bin}" could not be started (${e.code}). Antivirus software may be blocking it.`);
  return new Error(`FFmpeg could not be started: ${e.message}`);
}

// Quick startup check, cached: proves the binary runs and has the encoders we need.
let ffmpegCheck = null;
export function checkFfmpeg() {
  if (!ffmpegCheck) {
    ffmpegCheck = new Promise((resolve, reject) => {
      const bin = ffmpegBin();
      const p = spawn(bin, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let outp = '';
      p.stdout.on('data', (d) => { outp += d; });
      const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`FFmpeg at "${bin}" did not respond within 20 s.`)); }, 20000);
      p.on('error', (e) => { clearTimeout(t); reject(ffmpegError(e, bin)); });
      p.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(`FFmpeg at "${bin}" failed to run (exit ${code}).`));
        const missing = ['libx264', 'libvpx-vp9', 'prores_ks', 'aac', 'libopus'].filter((enc) => !outp.includes(enc));
        resolve({ path: bin, missing });
      });
    });
    ffmpegCheck.catch(() => { ffmpegCheck = null; }); // allow a retry after fixing the cause
  }
  return ffmpegCheck;
}

// Builds the final file from the captured clip: optional hold on the last frame, watermark,
// fades, and the soundtrack (Web Audio WAV + <audio> element tracks), trimmed to the clip.
//   clipStart     – where the clip starts on the artifact's timeline (s); the WAV starts at 0
//   clipDuration  – captured length (s); total = clipDuration + hold
//   post          – true when the video must be re-encoded (gif / hold / fades / watermark);
//                   then videoPath is a near-lossless intermediate, otherwise it's already final
// tracks: [{ path, at (s), offset (s), end (s|null), volume, loop }] on the artifact timeline
// customAudio: { path, mix: 'replace'|'mix', volume (0–1), loop } – a user's own track, from the video's
//   start; with 'replace' the caller passes no wavPath/tracks, so only this track is heard
export async function finalize({ format, quality = 'standard', videoPath, wavPath, tracks = [], clipStart = 0, clipDuration,
  hold = 0, fadeIn = false, fadeOut = false, fadeDuration = 0.5, watermark = null, customAudio = null, out, width, height, fps, post, signal, content = 'flat' }) {
  const total = clipDuration + hold;
  const fd = Math.min(fadeDuration, total / 2);
  const f3 = (n) => Math.max(0, n).toFixed(3);

  const inputs = ['-i', videoPath];
  let n = 1;
  const graph = [];

  // ---- video chain
  let vLabel = null;
  if (post) {
    const v = ['[0:v]setpts=PTS-STARTPTS'];
    if (hold > 0) v.push(`tpad=stop_mode=clone:stop_duration=${f3(hold)}`);
    let chain = v.join(',');
    if (watermark?.path) {
      inputs.push('-i', watermark.path);
      const wmW = Math.max(16, Math.round(width * watermark.size / 2) * 2);
      const m = Math.round(Math.min(width, height) * 0.04);
      const pos = {
        tl: [`${m}`, `${m}`], tr: [`main_w-overlay_w-${m}`, `${m}`], bl: [`${m}`, `main_h-overlay_h-${m}`],
        br: [`main_w-overlay_w-${m}`, `main_h-overlay_h-${m}`], center: ['(main_w-overlay_w)/2', '(main_h-overlay_h)/2'],
      }[watermark.position] || [`main_w-overlay_w-${m}`, `main_h-overlay_h-${m}`];
      graph.push(`[${n}:v]format=rgba,scale=${wmW}:-1:flags=lanczos,colorchannelmixer=aa=${watermark.opacity.toFixed(3)}[wm]`);
      graph.push(`${chain}[base]`);
      // format=yuv444p drops the alpha channel the overlay adds (otherwise faded GIF frames turn transparent)
      chain = `[base][wm]overlay=x=${pos[0]}:y=${pos[1]}:format=auto,format=yuv444p`;
      n++;
    }
    if (fadeIn) chain += `,fade=t=in:st=0:d=${f3(fd)}`;
    if (fadeOut) chain += `,fade=t=out:st=${f3(total - fd)}:d=${f3(fd)}`;
    if (format === 'gif') {
      graph.push(`${chain},fps=${fps},scale=${width}:-2:flags=lanczos,split[ga][gb]`, '[ga]palettegen=stats_mode=diff:max_colors=256[gp]',
        '[gb][gp]paletteuse=dither=sierra2_4a:diff_mode=rectangle[vout]');
    } else {
      graph.push(`${chain},format=${format === 'mov' ? 'yuv422p10le' : 'yuv420p'}[vout]`);
    }
    vLabel = '[vout]';
  }

  // ---- audio chain (all times converted to the clip's own timeline)
  const parts = [];
  if (format !== 'gif') {
    if (wavPath) {
      inputs.push('-i', wavPath);
      // the soundtrack keeps playing under a held last frame (it was rendered that far)
      parts.push(`[${n}:a]atrim=start=${f3(clipStart)}:duration=${f3(total)},asetpts=PTS-STARTPTS,aresample=48000[a${parts.length}]`);
      n++;
    }
    for (const t of tracks) {
      let at = t.at - clipStart, offset = t.offset;
      if (at < 0) { offset -= at; at = 0; }
      const end = t.end != null ? Math.min(t.end - clipStart, total) : total;
      const len = end - at;
      if (len <= 0.01 || at >= total) continue;
      if (t.loop) inputs.push('-stream_loop', '-1');
      inputs.push('-i', t.path);
      const delay = Math.round(at * 1000);
      parts.push(`[${n}:a]atrim=start=${f3(offset)}:duration=${f3(len)},asetpts=PTS-STARTPTS,` +
        `volume=${(+t.volume || 1).toFixed(3)},aresample=48000,adelay=${delay}|${delay}[a${parts.length}]`);
      n++;
    }
    if (customAudio?.path) {
      // the user's track starts with the video (not the artifact's timeline) and is cut to its length
      if (customAudio.loop) inputs.push('-stream_loop', '-1');
      inputs.push('-i', customAudio.path);
      parts.push(`[${n}:a]atrim=0:${f3(total)},asetpts=PTS-STARTPTS,volume=${(customAudio.volume ?? 1).toFixed(3)},` +
        `aresample=48000,aformat=channel_layouts=stereo[a${parts.length}]`);
      n++;
    }
  }
  let aLabel = null;
  if (parts.length) {
    graph.push(...parts);
    const labels = parts.map((_, i) => `[a${i}]`).join('');
    let a = parts.length > 1 ? `${labels}amix=inputs=${parts.length}:normalize=0,` : `${labels}`;
    a += `apad,atrim=0:${f3(total)}`;
    if (fadeIn) a += `,afade=t=in:st=0:d=${f3(fd)}`;
    if (fadeOut) a += `,afade=t=out:st=${f3(total - fd)}:d=${f3(fd)}`;
    graph.push(`${a}[aout]`);
    aLabel = '[aout]';
  }

  const args = [...inputs];
  if (graph.length) args.push('-filter_complex', graph.join(';'));
  args.push('-map', vLabel || '0:v');
  if (aLabel) args.push('-map', aLabel);
  if (format === 'gif') args.push('-loop', '0');
  else {
    args.push(...(post ? videoArgs(format, quality, content) : ['-c:v', 'copy']));
    if (aLabel) args.push(...audioArgs(format), '-ac', '2');
    args.push('-t', f3(total));
    if (format === 'mp4') args.push('-movflags', '+faststart');
  }
  args.push(out);
  await run(args, { signal });
}

// Saves one frame of a rendered video as a PNG (t in seconds on the video's own timeline).
export async function extractPoster({ videoPath, time, out, signal }) {
  await run(['-ss', Math.max(0, time).toFixed(3), '-i', videoPath, '-frames:v', '1', '-update', '1', out], { signal });
}

export function wavHeader(dataBytes, sampleRate, channels = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}
