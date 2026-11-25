# Artifact → Video

Turn animated HTML artifacts (Claude artifacts, GSAP/CSS/Canvas/SVG motion pieces) into
**MP4, WebM, MOV (ProRes) or GIF**, with frame-exact timing and sample-exact sound.

Upload an `.html` file, pick resolution / format / aspect / fps / quality, turn sound on or off, and download the video.

## Features

- **Presets:** one click for YouTube 1080p / 4K, Reels / Shorts / TikTok (9:16), Feed post (4:5), Square, Website background (silent WebM), GIF, Master (ProRes) and Quick preview. Changing any field afterwards switches the preset to *Custom*.
- **Trim:** render only *Start at* → *End at* of the animation (seconds), with live thumbnails of the first and last frame and a slider under each. Frames before the start are skipped, not captured, and the sound is cut to match. In the desktop app each artifact in a batch can have its own trim.
- **Soundtrack:** add several audio files (MP3, WAV, M4A, AAC, OGG, FLAC, Opus) and pick one to replace the artifact's sound or mix with it, with volume and loop. Fades apply to it. In the desktop app each artifact can have its own track.
- **Hold last frame / end card:** freeze the final frame for 1–5 s. The soundtrack keeps playing underneath.
- **Fade in / fade out:** from and to black, picture and sound together, 0.3–2 s.
- **Watermark / logo:** PNG, JPG or WebP (transparent PNG works best), five positions, four sizes labelled with their real pixel size, and an opacity slider.
- **Poster image:** saves a PNG of one frame next to the video, with a live preview of the chosen frame (watermark and fades included).
- **Output timeline:** a live diagram of the finished video (trim window, held frame, fades, poster pin) above the Convert button.

Two ways to run it, both on the same render engine (`src/render`):

- **Web app** (this folder): Express + Docker, for hosting online. The rest of this README covers it.
- **Desktop app** (`desktop/`): an Electron Windows installer with bundled Chromium and FFmpeg, a batch queue and native file dialogs. See [desktop/README.md](desktop/README.md).

**Documentation:** [User guide](docs/user-guide.md) · [Architecture](docs/architecture.md) · [HTTP API](docs/api.md) · [CLI](docs/cli.md) · [Contributing](docs/contributing.md) · [Tech debt](docs/tech-debt.md)

## Stack

| Layer | Choice | Why |
|---|---|---|
| Render engine | **Node.js 20+ and Playwright (headless Chromium)** | The real browser engine, so the artifact looks exactly like it does in Chrome |
| Timing | **Virtual clock** injected before page scripts | `performance.now`, `Date`, `requestAnimationFrame`, timers, CSS/WAAPI animations and `<video>` all advance exactly 1/fps per frame. No dropped frames, even at 4K on a slow VPS |
| Sound | **AudioContext → OfflineAudioContext shim** | Everything the page schedules on Web Audio is rendered offline on the same virtual timeline, so sound stays in sync with picture. `<audio>` elements are logged and mixed by FFmpeg |
| Encoding | **FFmpeg** | H.264/AAC, VP9/Opus, ProRes/PCM (Draft = Proxy, Standard = 422, High = 422 HQ), palette-optimized GIF |
| Speed | **Parallel segment rendering** | A job is split across N browser pages. Each replays the same deterministic clock (seeded `Math.random`), fast-forwards to its slice, captures it, and the slices are joined losslessly |
| API | **Express**, in-memory job queue, **Server-Sent Events** for progress | Simple to run. Swap `src/jobs.js` for BullMQ + Redis to scale to several servers |
| UI | Plain HTML/CSS/JS (no build step), Archivo font bundled | Served by the same process. Shared with the desktop app: `public/base.css` (design system) and `public/finishing.js` (presets, soundtrack, trim, fades, watermark, poster, previews, output timeline) |
| Deploy | **Docker** (Playwright base image + ffmpeg) behind **Nginx** | One container on a VPS |

## How a render works

1. **Probe.** The artifact is opened once to read its title, find a start button ("Play with sound", "Start", …) and detect its length (GSAP `window.film`, the GSAP global timeline, CSS animations or media duration).
2. **Load.** N pages load it in real time (fonts, CDN scripts, pre-rendered audio). Popular CDN files are served from `asset-mirror/`.
3. **Start.** The clock freezes and the start button is clicked, or for pages that play on load the clock is frozen from the first script.
4. **Capture.** For each frame: advance the clock 1/fps, screenshot through CDP, and pipe the image straight into FFmpeg.
5. **Sound.** The last page plays through the whole timeline and renders the Web Audio graph offline to a WAV.
6. **Finalize.** Concatenate the segments, mux in the audio, and write the output (or build the palette GIF).

## Run locally (Windows / Laragon, macOS, Linux)

```bash
# needs Node 20+ and ffmpeg on PATH  (Windows: winget install Gyan.FFmpeg)
npm install
npx playwright install chromium
npm run mirror        # optional: pre-download common CDN libs
npm start             # http://localhost:3000
```

CLI (no server):

```bash
node src/cli.js artifact.html out.mp4 --resolution 1080p --fps 30 --quality standard
node src/cli.js artifact.html out.webm --no-sound --duration 12
node src/cli.js artifact.html out.gif --resolution 720p --fps 20
node src/cli.js artifact.html out.mov --start "#play" --hide "#controls"
node src/cli.js artifact.html --preset reels --trim-start 2 --trim-end 12 --hold 2 --fade-in --fade-out
node src/cli.js artifact.html out.mp4 --watermark logo.png --wm-pos br --wm-size 0.12 --wm-opacity 0.85 --poster 3.5
node src/cli.js artifact.html out.mp4 --audio music.mp3 --audio-mix replace --audio-volume 0.8 --audio-loop
```

The HTTP API (uploads, watermarks, audio files, jobs, progress over SSE, downloads, posters) is documented in [docs/api.md](docs/api.md).

## Deploy on a VPS (Docker + Nginx)

```bash
git clone <repo> /opt/artifacts-to-mp4 && cd /opt/artifacts-to-mp4
npm run mirror                       # optional, bakes CDN libs into the image
docker compose up -d --build
sudo cp deploy/nginx.conf /etc/nginx/sites-available/video.example.com   # edit the domain
sudo ln -s /etc/nginx/sites-available/video.example.com /etc/nginx/sites-enabled/
sudo certbot --nginx -d video.example.com && sudo systemctl reload nginx
```

Sizing: plan for about 1 vCPU and 1 GB RAM per render worker. Measured on a 2 vCPU box: the 55 s sample artifact at 1080p30 with sound (1,635 frames) took 4 m 38 s, capturing about 7 frames/s. Throughput grows roughly with `RENDER_WORKERS` until you run out of CPU cores.

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `RENDER_WORKERS` | one per CPU core, max 4 | browser pages per job (parallel segments) |
| `RENDER_CONCURRENCY` | 1 | jobs rendered at the same time |
| `QUEUE_MAX` | 20 | max queued jobs |
| `PREVIEW_CONCURRENCY` | 2 | poster-frame previews rendered at the same time |
| `MAX_DURATION` | 300 | max seconds per video |
| `MAX_RESOLUTION` | 2160p | highest resolution offered |
| `MAX_GIF_RESOLUTION` / `MAX_GIF_FPS` | 720p / 30 | GIF limits |
| `MAX_UPLOAD_MB` | 25 | upload limit |
| `MAX_AUDIO_MB` | 30 | soundtrack file limit (keep nginx `client_max_body_size` above it) |
| `JOB_TTL_MIN` | 60 | delete uploads and outputs after this many minutes |
| `JOB_TIMEOUT_MIN` | 30 | kill renders that run longer |
| `STORAGE_DIR` | ./storage | uploads, outputs, temp files |
| `ASSET_MIRROR_DIR` | ./asset-mirror | local CDN mirror (`<host>/<path>`) |
| `ENABLE_GPU` | off | `1` lets the capture browser use the graphics card (experimental; only helps on machines with a real GPU) |
| `ENABLE_WEBGL` | off | `1` forces SwiftShader WebGL (Chromium already falls back to it; WebGL scenes are drawn on the CPU and render slowly) |
| `BROWSER_PROXY` | – | outbound proxy for artifact assets |
| `ALLOW_PRIVATE_NETWORK` | off | `1` lets artifacts reach localhost / private IPs (keep off in production) |
| `TRUST_PROXY`, `COOKIE_SECURE` | loopback, off | set `1` / `1` behind Nginx with HTTPS |

## Performance

Each frame is rendered by Chromium and screenshotted, and that is the bottleneck. At 1080p a frame costs roughly 150 ms of CPU per browser page. About half of that is drawing the artifact (blurs, gradients and full-screen effects are expensive); the rest is reading the pixels back and JPEG-encoding them. FFmpeg encoding runs alongside and is a small share.

How to make it faster:

- **More CPU cores.** Jobs are split across one browser page per core, so throughput scales almost linearly with cores.
- **GPU** (`ENABLE_GPU=1`, or the toggle in the desktop app). Experimental: it moves drawing onto the graphics card on machines that have one.
- **Fewer frames.** 24 fps renders 20% fewer frames than 30 fps.
- **Sound off.** Skips the artifact's audio pre-render and saves a few seconds per job.
- Choosing a resolution below 1080p does **not** speed up capture: pages are always drawn at least at their 1080p layout size and scaled down by FFmpeg, which keeps text sharp.

## Security

Uploaded HTML is untrusted code. It runs in a fresh Chromium context per worker with service workers, downloads and popups blocked. Network requests to `localhost`, private and link-local ranges are blocked (SSRF guard). Jobs belong to an anonymous per-browser cookie, uploads and API calls are rate-limited, and every file is deleted after `JOB_TTL_MIN`. For a public site, also put Nginx rate limiting or basic auth in front of the app.

## Make your artifacts render perfectly (optional hints)

The converter auto-detects most things. Artifacts you author can also state them explicitly:

```html
<meta name="a2v:duration" content="54.5">     <!-- seconds -->
<meta name="a2v:start" content="#startSnd">   <!-- button to click to begin (with sound) -->
<meta name="a2v:hide" content="#ui, .hint">   <!-- elements to keep out of the video -->
```

Or set `window.A2V_DURATION = 54.5`. A paused GSAP timeline exposed as `window.film` is detected automatically.

## Known limits

- WebGL/three.js artifacts render on the CPU without a GPU: seconds per frame for heavy scenes. They're flagged in the UI and captured at the output size; use 480p/720p for previews, or the desktop app's GPU option.
- Audio from `MediaStream`/microphone or cross-origin `<audio>` without CORS is not captured.
- Artifacts that depend on real user input (hover, scroll) render whatever they show without interaction.

## Roadmap

Done: trim, hold last frame, fades, presets, poster image, watermark, custom soundtrack (web, desktop and CLI).

### ⭐ Next up: Templates / variables (top priority)

One HTML artifact → many personalised videos, by swapping text, numbers, colors and images per render.

- **Mark variables in the artifact** (detected at probe time, like length and start button):
  - placeholders: `<h1>{{headline}}</h1>`
  - attributes, keeping the current text as the default: `<h1 data-a2v="headline">Your MVP worked.</h1>`
  - colors via CSS variables (`--brand`), images via `<img data-a2v="logo">`
  - JS hook for canvas / GSAP-drawn content: `window.a2v.vars.users`
- **Single render:** the UI builds a form from the detected variables (text, number, color, image).
- **Batch:** upload a CSV, one video per row, file names from a pattern such as `{client}-{resolution}.mp4`. Desktop: each row becomes a queue item. Web: one job with N outputs (zip download).
- **Engine:** values are injected before page scripts run (same step as the virtual clock), so GSAP measures the new text and layouts adapt.
- **CLI:** `--var headline="Acme's MVP worked."`, `--vars data.csv --name "{client}"`.
- **Guards:** warn when a variable's element changes size a lot (text overflow), optional max length per variable; text hard-coded inside JS strings needs the JS hook.
- **Plan:** (1) detection + form, (2) CSV batch + naming, (3) image/color variables + overflow warning.

### Later, roughly in order of value

1. **Transparent background:** ProRes 4444 / WebM with alpha for artifacts with no background, for use in video editors.
2. **Multi-format export:** one render, several outputs (e.g. MP4 + GIF + poster) in a single job.
3. **Speed control:** 0.5×–2× playback without re-timing the artifact.
4. **Loop export:** seamless loop for GIF / WebM, or N repeats.
5. **Burned-in subtitles:** upload an `.srt`/`.vtt` and render it into the picture.
6. **Soundtrack extras:** start offset into the track, ducking the artifact's sound under it, waveform in the timeline.
7. **Render from URL:** convert a published artifact link instead of a file.
8. **Desktop:** watch folder (auto-convert new HTML files), auto-update, render on your VPS from the desktop app.
9. **Web (hosted):** accounts and render history, quotas and plans, shareable links to finished videos.
