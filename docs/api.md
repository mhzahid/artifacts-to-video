# HTTP API

The web app's UI uses this API, and you can call it from scripts too. Everything is JSON unless noted. The base URL is wherever the app runs, e.g. `http://localhost:3000`.

## Authentication and ownership

There are no API keys. On the first request the server sets an anonymous cookie, `a2v_owner` (HttpOnly, one year). Uploads, watermarks and jobs belong to that cookie, and other owners get `404`. **Keep the cookie between calls** (`curl -c jar -b jar …`).

## Typical flow

```bash
J=cookies.txt
# 1. upload the artifact (also probes it)
curl -s -c $J -b $J -F file=@artifact.html http://localhost:3000/api/uploads
# → {"uploadId":"Xy3…","name":"artifact.html","size":48211,"info":{…}}

# 2. (optional) upload a watermark image
curl -s -c $J -b $J -F file=@logo.png http://localhost:3000/api/watermarks
# → {"watermarkId":"Qm9…"}

# 2b. (optional) upload a soundtrack
curl -s -c $J -b $J -F file=@music.mp3 http://localhost:3000/api/audio
# → {"audioId":"Tr4…","name":"music.mp3","duration":31.2}

# 3. create a job
curl -s -c $J -b $J -H 'Content-Type: application/json' http://localhost:3000/api/jobs -d '{
  "uploadId": "Xy3…",
  "options": { "preset": "reels", "format": "mp4", "resolution": "1080p", "aspect": "9:16", "fps": 30,
               "trimStart": 2, "trimEnd": 12, "hold": 2, "fadeIn": true, "fadeOut": true, "poster": true,
               "watermark": { "enabled": true, "id": "Qm9…", "position": "br", "size": 0.12, "opacity": 0.85 } }
}'
# → 202 {"id":"aB7…","status":"queued",…}

# 4. follow progress (Server-Sent Events) or poll GET /api/jobs/:id
curl -N -c $J -b $J http://localhost:3000/api/jobs/aB7…/events

# 5. download
curl -c $J -b $J -OJ http://localhost:3000/api/jobs/aB7…/download
curl -c $J -b $J -OJ http://localhost:3000/api/jobs/aB7…/poster
```

## Endpoints

### `GET /api/presets`

Everything the UI needs to build its dropdowns.

```json
{
  "formats": [{ "id": "mp4", "label": "MP4", "codec": "H.264 + AAC", "audio": true }, …],
  "resolutions": [{ "id": "1080p", "width": 1920, "height": 1080, "allowed": true, … }, …],
  "aspects": ["16:9", "9:16", "1:1", "4:5"],
  "fps": [24, 25, 30, 60],
  "qualities": ["draft", "standard", "high"],
  "limits": { "maxDuration": 300, "maxResolution": "2160p", "maxGifResolution": "720p", "maxGifFps": 30, "maxUploadMb": 25 },
  "presets": { "custom": { "label": "Custom" }, "youtube1080": { "label": "YouTube · 1080p", "format": "mp4", … }, … },
  "presetFields": ["format", "resolution", "aspect", "fps", "quality", "sound"]
}
```

### `POST /api/uploads`

Multipart form, field **`file`**: one `.html` / `.htm` file, at most `MAX_UPLOAD_MB` (default 25 MB). The server checks that it looks like HTML, then probes it.

`200`:

```json
{
  "uploadId": "Xy3…", "name": "artifact.html", "size": 48211,
  "info": {
    "title": "Keep the MVP. Lose the ceiling.",
    "start": "#startSnd", "startText": "Play with sound",
    "duration": 54.5, "durationSource": "GSAP timeline (window.film)",
    "hide": "", "poster": "data:image/jpeg;base64,…", "aspect": "16:9", "theme": "light"
  }
}
```

`start` is `null` for artifacts that play on load. `duration` is `null` if it couldn't be detected; the job then needs `options.duration`.

Errors: `400` not a single HTML file / doesn't look like HTML · `413` too large · `422` the artifact couldn't be opened · `429` rate limit (30 per 10 min).

### `POST /api/uploads/:id/frame`

Renders one frame of an uploaded artifact, as the video would show it: used for the poster preview.

```json
{ "time": 12.5, "options": { "aspect": "9:16", "fps": 30, "theme": "light", "mode": "auto" } }
```

`time` is seconds into the artifact's animation (not the trimmed video). `options` uses the same fields as a job; only the start, aspect, theme, fps and hide options matter. Returns `{ "image": "data:image/jpeg;base64,…", "time": 12.5 }`, a 960 px-wide JPEG. The watermark and fades are not applied (the UI overlays them).

Errors: `404` upload unknown or someone else's · `422` the artifact couldn't be rendered at that time · `429` (120 per 10 min). At most `PREVIEW_CONCURRENCY` (default 2) previews render at once; others wait.

### `POST /api/watermarks`

Multipart form, field **`file`**: PNG, JPEG or WebP, at most 5 MB, checked by its first bytes. Returns `{ "watermarkId": "Qm9…" }`. The image is deleted after `JOB_TTL_MIN` unless a queued or running job uses it.

Errors: `400` not a supported image · `413` larger than 5 MB · `429` (30 per 10 min).

### `POST /api/audio`

Multipart form, field **`file`**: an audio file (MP3, WAV, M4A, AAC, OGG, FLAC, Opus), at most `MAX_AUDIO_MB` (default 30 MB). FFmpeg checks that it has an audio stream. Returns `{ "audioId": "Tr4…", "name": "music.mp3", "duration": 31.2 }` (`duration` in seconds, `null` if unknown). Errors: `400` no readable audio, `413` too large, `429` (30 per 10 min). The file is deleted after `JOB_TTL_MIN` without use; each job that uses it restarts the timer. Use it in a job as `"audio": { "track": "<audioId>", … }`.

### `POST /api/jobs`

```json
{ "uploadId": "Xy3…", "options": { … } }
```

Returns `202` with the [job object](#job-object). Errors: `404` upload unknown, expired or someone else's · `400` invalid options, or watermark / audio file expired · `503` queue full (`QUEUE_MAX`) · `429` (20 per 10 min).

### `GET /api/jobs/:id`

Returns the current [job object](#job-object).

### `GET /api/jobs/:id/events`

A Server-Sent Events stream. It sends the job object right away, then again on every change (capture progress about every 400 ms), with a `: ping` comment every 20 s. Close the connection when `status` is `done`, `error` or `cancelled`.

```
data: {"id":"aB7…","status":"running","progress":{"stage":"capturing","frame":420,"frames":900,"progress":0.47,"fps":7.4,"eta":65,"workers":4,"elapsed":71.2},…}
```

### `DELETE /api/jobs/:id`

Cancels a queued or running job and returns the job object.

### `GET /api/jobs/:id/download`

The finished file, with `Content-Disposition: attachment; filename="<title>-<resolution>-<fps>fps.<ext>"`. Supports range requests. Add `?inline=1` to play it in the browser. Returns `409` if the job isn't done.

### `GET /api/jobs/:id/poster`

The poster PNG (`<title>-poster.png`). Returns `404` if the job has no poster or isn't done.

### `GET /healthz`

`{ "ok": true, "queued": 0, "running": 1 }`, or `500` if the capture browser can't start. Use it for uptime checks.

## Options

All fields are optional. Invalid values fall back to the default; numbers are clamped.

| Field | Type / values | Default | Notes |
|---|---|---|---|
| `preset` | preset id | `custom` | Informational. The client fills the preset's fields itself (see `presets` in `/api/presets`) |
| `format` | `mp4` `webm` `mov` `gif` | `mp4` | |
| `resolution` | `480p` `720p` `1080p` `1440p` `2160p` | `1080p` | Short side. Capped by `MAX_RESOLUTION`; GIF by `MAX_GIF_RESOLUTION` |
| `aspect` | `16:9` `9:16` `1:1` `4:5` | `16:9` | |
| `fps` | `24` `25` `30` `60` | `30` | GIF capped by `MAX_GIF_FPS` |
| `quality` | `draft` `standard` `high` | `standard` | |
| `sound` | boolean | `true` | Always `false` for GIF |
| `duration` | seconds or `"auto"` | `auto` | 0.5 – `MAX_DURATION` |
| `trimStart` | seconds | `0` | Into the animation |
| `trimEnd` | seconds or `"auto"` | `auto` | Ignored if ≤ `trimStart` |
| `hold` | seconds, 0–10 | `0` | Freeze the last frame |
| `fadeIn`, `fadeOut` | boolean | `false` | |
| `fadeDuration` | seconds, 0.1–3 | `0.5` | Capped at half the video length |
| `poster` | boolean | `false` | |
| `posterTime` | seconds or `"auto"` | `auto` (middle) | Into the finished video |
| `watermark` | object or omitted | none | `{ enabled: true, id, position, size, opacity }` |
| `watermark.position` | `br` `bl` `tr` `tl` `center` | `br` | |
| `watermark.size` | 0.04–0.4 | `0.12` | Share of the video width |
| `watermark.opacity` | 0.1–1 | `0.85` | |
| `audio` | object or omitted | none (artifact's own sound) | `{ track, mix, volume, loop }`. Ignored when `sound` is off or for GIF |
| `audio.track` | audio id | | From `POST /api/audio`. `"artifact"` = no custom track |
| `audio.mix` | `replace` `mix` | `replace` | Replace the artifact's sound, or mix with it |
| `audio.volume` | 0–1 | `1` | |
| `audio.loop` | boolean | `false` | Repeat the track if it's shorter than the video |
| `mode` | `auto` `click` `autoplay` | `auto` | Start mode |
| `startSelector` | CSS selector | detected | Up to 300 chars |
| `hideSelectors` | CSS selectors, comma separated | none | Up to 1000 chars |
| `autoHideControls` | boolean | `true` | |
| `theme` | `light` `dark` | `light` | `prefers-color-scheme` for the page |

## Job object

```json
{
  "id": "aB7…", "status": "done", "title": "Keep the MVP. Lose the ceiling.",
  "opts": { "format": "mp4", "resolution": "1080p", … , "watermark": { "position": "br", "size": 0.12, "opacity": 0.85 } },
  "createdAt": 1791700000000, "position": 0,
  "progress": { "stage": "done", "progress": 1 },
  "result": {
    "title": "…", "duration": 12, "frames": 300, "fps": 30, "width": 1080, "height": 1920, "workers": 4,
    "clip": [2, 12], "hold": 2, "fades": [true, true], "watermark": true, "poster": true,
    "mode": "click", "startSelector": "#startSnd", "durationSource": "GSAP timeline (window.film)",
    "audio": { "source": "Web Audio", "peak": 0.912 }, "bytes": 2483112, "seconds": 61.4, "captureFps": 7.2, "gpu": false
  },
  "error": null, "uploadId": "Xy3…",
  "download": "/api/jobs/aB7…/download", "posterDownload": "/api/jobs/aB7…/poster"
}
```

- **`status`:** `queued` → `running` → `done` | `error` | `cancelled`.
- **`position`:** place in the queue (1 = next); 0 when not queued.
- **`progress.stage`:** `queued`, `probing`, `loading` (adds `duration`, `durationSource`, `mode`, `frames`, `workers`, `trim`), `capturing` (adds `frame`, `frames`, `progress`, `fps`, `eta`), `encoding`, `finalizing`, `poster`, `done`.
- **`result.duration`:** final length = clip + hold. `clip` is the [start, end] range of the animation, in seconds.
- **`result.audio.source`:** `Web Audio`, `media elements`, `Web Audio + media`, `none detected` or `off`.
- **`error`:** a readable reason, e.g. *"Start button "#play" never became clickable."*
- Server paths are never included; `result.poster` is a boolean on the web.

## Errors and limits

Errors are `{ "error": "message" }` with a matching status code.

| Limit | Default | Env var |
|---|---|---|
| Upload size | 25 MB (watermark 5 MB) | `MAX_UPLOAD_MB` |
| Audio file size | 30 MB | `MAX_AUDIO_MB` |
| Video length | 300 s | `MAX_DURATION` |
| Queue length | 20 jobs | `QUEUE_MAX` |
| Jobs rendered at once | 1 | `RENDER_CONCURRENCY` |
| Render timeout | 30 min | `JOB_TIMEOUT_MIN` |
| File retention | 60 min | `JOB_TTL_MIN` |
| Rate limits | uploads 30, watermarks 30, jobs 20 per 10 min per IP | (in code) |

Behind Nginx, set `TRUST_PROXY` so rate limits see the real client IP, and `COOKIE_SECURE=1` on HTTPS. Uploads and jobs are kept in memory, so a server restart forgets them and clears `storage/`.
