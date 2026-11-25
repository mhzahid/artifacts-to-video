# CLI

Render without the server, which is handy for scripts, CI and batch jobs. It uses the same engine and options as the web and desktop apps.

```bash
node src/cli.js <input.html> [output] [options]
# or: npm run render -- <input.html> [output] [options]
```

Requirements: Node 20+, `npm install`, `npx playwright install chromium`, and FFmpeg on `PATH` (or set `FFMPEG_PATH`).

- **Output:** if omitted, the video is written next to the input as `<input>.<format>`. If you give a file name, its extension picks the format unless `--format` is set.
- **Assets:** relative files next to the HTML (`./images/…`) load, as in the desktop app.
- **Exit code:** 0 on success, 1 on error.

## Examples

```bash
# basics
node src/cli.js artifact.html out.mp4 --resolution 1080p --fps 30 --quality standard
node src/cli.js artifact.html out.webm --no-sound --duration 12
node src/cli.js artifact.html out.gif --resolution 720p --fps 24
node src/cli.js artifact.html out.mov --quality high

# presets (explicit flags still win)
node src/cli.js artifact.html --preset reels
node src/cli.js artifact.html --preset youtube4k --fps 60

# trim, end card, fades
node src/cli.js artifact.html clip.mp4 --trim-start 10 --trim-end 25 --hold 2 --fade-in --fade-out --fade 1

# branding and thumbnail
node src/cli.js artifact.html out.mp4 --watermark logo.png --wm-pos br --wm-size 0.12 --wm-opacity 0.85 --poster 3.5

# your own music instead of the artifact's sound, looped, at 80%
node src/cli.js artifact.html out.mp4 --audio music.mp3 --audio-mix replace --audio-volume 0.8 --audio-loop

# tricky artifacts
node src/cli.js artifact.html out.mp4 --start "#play" --hide "#controls, .hint"
node src/cli.js artifact.html out.mp4 --mode autoplay --duration 20
```

Batch a folder (bash):

```bash
for f in artifacts/*.html; do node src/cli.js "$f" "out/$(basename "${f%.*}").mp4" --preset youtube1080; done
```

PowerShell:

```powershell
Get-ChildItem artifacts\*.html | % { node src/cli.js $_.FullName "out\$($_.BaseName).mp4" --preset youtube1080 }
```

## Options

### Output

| Flag | Values | Default |
|---|---|---|
| `--preset` | `youtube1080` `youtube4k` `reels` `feed45` `square` `landing` `gif` `master` `preview` | none |
| `--format` | `mp4` `webm` `mov` `gif` | from the output extension, else `mp4` |
| `--resolution` | `480p` `720p` `1080p` `1440p` `2160p` | `1080p` |
| `--aspect` | `16:9` `9:16` `1:1` `4:5` | `16:9` |
| `--fps` | `24` `25` `30` `60` | `30` |
| `--quality` | `draft` `standard` `high` | `standard` |
| `--no-sound` | | sound on |
| `--duration` | seconds | auto-detected |

A preset only fills the fields you didn't pass. See the [user guide](user-guide.md#preset) for what each preset sets.

### Trim and finishing

| Flag | Meaning |
|---|---|
| `--trim-start <s>` | Start this many seconds into the animation |
| `--trim-end <s>` | End this many seconds into the animation |
| `--hold <s>` | Freeze the last frame for 0–10 s (sound keeps playing) |
| `--fade-in`, `--fade-out` | Fade from / to black, picture and sound |
| `--fade <s>` | Fade length, 0.1–3 s (default 0.5) |

### Watermark and poster

| Flag | Meaning |
|---|---|
| `--watermark <file>` | PNG / JPG / WebP logo to overlay |
| `--wm-pos` | `br` (default) `bl` `tr` `tl` `center` |
| `--wm-size` | Logo width as a share of the video width, 0.04–0.4 (default 0.12) |
| `--wm-opacity` | 0.1–1 (default 0.85) |
| `--poster [s]` | Also save `<output>.png`. Optional time in seconds into the finished video (default: the middle) |

### Soundtrack

| Flag | Meaning |
|---|---|
| `--audio <file>` | MP3 / WAV / M4A / AAC / OGG / FLAC / Opus to use as the soundtrack. Starts with the video |
| `--audio-mix` | `replace` (default): only this track; `mix`: together with the artifact's sound |
| `--audio-volume` | 0–1 (default 1) |
| `--audio-loop` | Repeat the track if it's shorter than the video |

Ignored with `--no-sound` and for GIF.

### Start and capture

| Flag | Meaning |
|---|---|
| `--mode` | `auto` (default), `click` or `autoplay` |
| `--start <selector>` | Button to click to start the animation |
| `--hide <selectors>` | Elements to hide from the video, comma separated |
| `--theme` | `light` (default) or `dark` |

Any other `--name value` pair is passed through to `normalizeOptions()` by its option name (for example `--autoHideControls false`). See the [options table](api.md#options).

## Environment variables

These are the ones that matter for the CLI (the full list is in the [main README](../README.md#environment-variables)):

| Var | Effect |
|---|---|
| `RENDER_WORKERS` | Parallel browser pages (default: one per core, max 4) |
| `FFMPEG_PATH` | FFmpeg binary to use |
| `CHROMIUM_PATH` | Chromium binary instead of Playwright's |
| `ENABLE_GPU=1`, `ENABLE_WEBGL=1` | See [architecture](architecture.md#chromium-configuration) |
| `ALLOW_PRIVATE_NETWORK=1` | Let the artifact load from localhost / LAN |
| `MAX_DURATION` | Longest allowed video (default 300 s) |

## Output

While rendering, a single progress line shows `capturing 420/900 (7.4 fps, eta 65s)`. At the end the CLI prints the result object (size, frames, duration, clip, audio source, capture speed) and the output path.
