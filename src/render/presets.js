// Output presets shared by the server, the CLI and the UI (served at /api/presets).

export const RESOLUTIONS = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
};

// Base CSS viewport per aspect. The page is laid out at this size and then
// rendered with deviceScaleFactor = outputWidth / baseWidth, so a 1920×1080 artifact
// renders natively at 1080p and is supersampled (not upscaled) at 4K.
export const ASPECTS = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
};

export const FORMATS = {
  mp4: { label: 'MP4', codec: 'H.264 + AAC', ext: 'mp4', mime: 'video/mp4', audio: true },
  webm: { label: 'WebM', codec: 'VP9 + Opus', ext: 'webm', mime: 'video/webm', audio: true },
  mov: { label: 'MOV ProRes', codec: 'ProRes 422 + PCM', ext: 'mov', mime: 'video/quicktime', audio: true },
  gif: { label: 'GIF', codec: 'animated GIF', ext: 'gif', mime: 'image/gif', audio: false },
};

export const FPS = [24, 25, 30, 60];

// One-click presets. Choosing one fills format/resolution/aspect/fps/quality (and sometimes sound);
// changing any of those fields afterwards switches the preset back to "Custom".
export const PRESETS = {
  custom: { label: 'Custom' },
  youtube1080: { label: 'YouTube 1080p', format: 'mp4', resolution: '1080p', aspect: '16:9', fps: 30, quality: 'standard' },
  youtube4k: { label: 'YouTube 4K', format: 'mp4', resolution: '2160p', aspect: '16:9', fps: 30, quality: 'high' },
  reels: { label: 'Reels, TikTok, Shorts (9:16)', format: 'mp4', resolution: '1080p', aspect: '9:16', fps: 30, quality: 'standard' },
  feed45: { label: 'Instagram, Facebook feed (4:5)', format: 'mp4', resolution: '1080p', aspect: '4:5', fps: 30, quality: 'standard' },
  square: { label: 'LinkedIn, X square (1:1)', format: 'mp4', resolution: '1080p', aspect: '1:1', fps: 30, quality: 'standard' },
  landing: { label: 'Website hero (silent WebM)', format: 'webm', resolution: '1080p', aspect: '16:9', fps: 30, quality: 'standard', sound: false },
  gif: { label: 'GIF for chat and email', format: 'gif', resolution: '480p', aspect: '16:9', fps: 24, quality: 'standard' },
  master: { label: 'Editing master (ProRes)', format: 'mov', resolution: '1080p', aspect: '16:9', fps: 30, quality: 'high' },
  preview: { label: 'Quick preview (720p draft)', format: 'mp4', resolution: '720p', aspect: '16:9', fps: 24, quality: 'draft' },
};
export const PRESET_FIELDS = ['format', 'resolution', 'aspect', 'fps', 'quality', 'sound'];
export const WATERMARK_POSITIONS = ['br', 'bl', 'tr', 'tl', 'center'];
export const QUALITIES = ['draft', 'standard', 'high'];

export const LIMITS = {
  maxDuration: +process.env.MAX_DURATION || 300,          // seconds
  maxResolution: process.env.MAX_RESOLUTION || '2160p',
  maxGifResolution: process.env.MAX_GIF_RESOLUTION || '720p',
  maxGifFps: +process.env.MAX_GIF_FPS || 30,
};

export function outputSize(resolution, aspect) {
  const p = RESOLUTIONS[resolution] || 1080;
  const a = ASPECTS[aspect] || ASPECTS['16:9'];
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  // "1080p" = 1080 on the short side, whatever the orientation
  const short = Math.min(a.w, a.h);
  const scale = p / short;
  return { width: even(a.w * scale), height: even(a.h * scale), base: a, dsf: (a.w * scale) / a.w };
}

const bool = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';

export function normalizeOptions(input = {}) {
  const o = {
    format: FORMATS[input.format] ? input.format : 'mp4',
    resolution: RESOLUTIONS[input.resolution] ? input.resolution : '1080p',
    aspect: ASPECTS[input.aspect] ? input.aspect : '16:9',
    fps: FPS.includes(+input.fps) ? +input.fps : 30,
    quality: QUALITIES.includes(input.quality) ? input.quality : 'standard',
    sound: !(input.sound === false || input.sound === 'false' || input.sound === '0' || input.sound === 'off'),
    duration: input.duration && input.duration !== 'auto' ? Math.max(0.5, Math.min(LIMITS.maxDuration, +input.duration || 0)) : 'auto',
    mode: ['auto', 'click', 'autoplay'].includes(input.mode) ? input.mode : 'auto',
    startSelector: String(input.startSelector || '').slice(0, 300),
    hideSelectors: String(input.hideSelectors || '').slice(0, 1000),
    autoHideControls: !(input.autoHideControls === false || input.autoHideControls === 'false'),
    theme: ['light', 'dark'].includes(input.theme) ? input.theme : 'light',
    preset: PRESETS[input.preset] ? input.preset : 'custom',
    // timing & finishing
    trimStart: Math.max(0, Math.min(LIMITS.maxDuration, +input.trimStart || 0)),
    trimEnd: input.trimEnd && input.trimEnd !== 'auto' && +input.trimEnd > 0 ? Math.min(LIMITS.maxDuration, +input.trimEnd) : 'auto',
    hold: Math.max(0, Math.min(10, +input.hold || 0)),
    fadeIn: bool(input.fadeIn),
    fadeOut: bool(input.fadeOut),
    fadeDuration: Math.max(0.1, Math.min(3, +input.fadeDuration || 0.5)),
    poster: bool(input.poster),
    posterTime: input.posterTime !== undefined && input.posterTime !== '' && input.posterTime !== 'auto' && isFinite(+input.posterTime) ? Math.max(0, +input.posterTime) : 'auto',
    // custom soundtrack: a library id chosen by the user; the file path is attached by the caller
    audio: input.audio && input.audio.track && input.audio.track !== 'artifact' ? {
      track: String(input.audio.track).slice(0, 64),
      mix: input.audio.mix === 'mix' ? 'mix' : 'replace',
      volume: Math.max(0, Math.min(1, input.audio.volume == null || input.audio.volume === '' ? 1 : +input.audio.volume || 0)),
      loop: bool(input.audio.loop),
    } : null,
    // watermark settings only; the image path is attached by the caller (never taken from user input)
    watermark: input.watermark && bool(input.watermark.enabled) ? {
      position: WATERMARK_POSITIONS.includes(input.watermark.position) ? input.watermark.position : 'br',
      size: Math.max(0.04, Math.min(0.4, +input.watermark.size || 0.12)),
      opacity: Math.max(0.1, Math.min(1, +input.watermark.opacity || 0.85)),
    } : null,
  };
  if (o.trimEnd !== 'auto' && o.trimEnd <= o.trimStart) o.trimEnd = 'auto';
  const cap = (res, max) => (RESOLUTIONS[res] > RESOLUTIONS[max] ? max : res);
  o.resolution = cap(o.resolution, LIMITS.maxResolution);
  if (o.format === 'gif') {
    o.resolution = cap(o.resolution, LIMITS.maxGifResolution);
    o.fps = Math.min(o.fps, LIMITS.maxGifFps);
    o.sound = false;
  }
  if (!o.sound) o.audio = null; // sound off = silent video, whatever track is chosen
  return o;
}
