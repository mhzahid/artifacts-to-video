# Contributing

## Dev setup

**Web app and engine** (repo root):

```bash
# Node 20+, FFmpeg on PATH (Windows: winget install Gyan.FFmpeg)
npm install
npx playwright install chromium
npm run mirror      # optional: download common CDN libs into asset-mirror/
npm run dev         # http://localhost:3000, restarts on file changes
```

**Desktop app** (`desktop/`, Windows for packaging; development also works on macOS and Linux):

```bash
cd desktop
npm install         # postinstall downloads ffmpeg.exe / electron if npm skipped install scripts
npm start           # syncs the engine, checks binaries, opens the app (Ctrl+Shift+I opens DevTools)
```

Building the installer, code signing and installer size are covered in [desktop/README.md](../desktop/README.md).

## Project layout

```
src/
  render/          render engine (shared by web, desktop and CLI)
    renderer.js    probe + render orchestration, browser, network guard
    inject.js      virtual clock + audio shim (runs inside the artifact page)
    encode.js      FFmpeg: frame pipe, finalize, poster
    presets.js     formats, presets, limits, normalizeOptions()
  jobs.js          job queue (shared)
  server.js        web API
  cli.js           command line
public/            web UI; finishing.js, base.css and fonts/ are shared with the desktop UI
asset-mirror/      local copies of CDN files, served instead of the network
scripts/           mirror-assets.js (fills asset-mirror/)
deploy/            nginx.conf
Dockerfile, docker-compose.yml
desktop/
  main.js          Electron main process
  preload.cjs      the only bridge between window and main (contextBridge)
  ui/              desktop window UI
  engine/          GENERATED copy of src/render + src/jobs.js
  ui/finishing.js  GENERATED copy of public/finishing.js
  scripts/         sync, ensure-binaries, fetch-chromium, dist, after-pack, icons, test cert
  test/fixture.html  3 s test artifact used by the smoke test
docs/              this documentation
```

## One engine, two apps

The engine lives in `src/`. The desktop app gets a copy through `npm run sync` (`desktop/scripts/sync-engine.mjs`), which runs automatically on `npm start` and `npm run dist`. It copies `src/render`, `src/jobs.js`, `asset-mirror/`, `public/finishing.js`, `public/base.css` and `public/fonts/`.

- **Edit only the originals** in `src/` and `public/`. Files in `desktop/engine/`, `desktop/ui/finishing.js`, `desktop/ui/base.css` and `desktop/ui/fonts/` are overwritten on every sync and are git-ignored.
- The engine must stay free of Electron and Express imports. Product differences are passed in instead: `assetDir` (desktop serves relative files), `JobQueue({ exposePaths })` (desktop sees local paths), and environment variables that `desktop/main.js` sets before importing the engine (`FFMPEG_PATH`, `PLAYWRIGHT_BROWSERS_PATH`, `RENDER_WORKERS`, `ENABLE_GPU` …).
- **Styles:** `public/base.css` holds the design tokens (colours, type, radii) and every shared component (fields, switches, sections, buttons, the output timeline). Each app's `app.css` only lays out its own screens. Change the look in `base.css`.
- The web and desktop UIs have separate `index.html` / `app.js`, but the Preset dropdown, the Soundtrack, Trim, Fades & ending, Watermark and Poster panels, and the output timeline come from `finishing.js` (`createFinishing()`, `drawTimeline()`). Their HTML uses the same element ids in both apps.
- **Fonts:** Archivo (variable, SIL Open Font License, `public/fonts/`) is bundled so the desktop app works offline and the web app makes no third-party requests.

## Adding a new render option

Work through this checklist, using an existing option such as `hold` as the model:

1. **`src/render/presets.js` → `normalizeOptions()`:** add the field with a default, type coercion and clamping. This is the only place user input is validated, for web, desktop and CLI alike.
2. **Engine:** use it in `renderer.js` (capture) and/or `encode.js` (`finalize()` filter graph). If it changes pixels or adds frames, include it in the `post` condition so segments use the intermediate codec.
3. **Result:** add it to the object `render()` returns if the UI should show it.
4. **Web UI:** add the control to `public/index.html`. If it belongs to presets/finishing, wire it in `finishing.js` (`read()`, `apply()`, badges, summary); otherwise wire it in `public/app.js` (`options()` / `applyOptions()`).
5. **Desktop UI:** add the same markup to `desktop/ui/index.html`, plus any wiring in `desktop/ui/app.js`. Anything involving local files (pickers, paths) goes through a new IPC handler in `main.js` and `preload.cjs`. **Never accept a file path from the renderer for the engine.**
6. **Web API:** if it involves an upload, add an endpoint that stores the file and returns an id, check ownership in `POST /api/jobs`, and clean it up in the housekeeping sweep.
7. **CLI:** add a flag in `src/cli.js` (or rely on the `--optionName value` passthrough).
8. **Docs:** [user guide](user-guide.md), [API options table](api.md#options), [CLI](cli.md).

## Testing

There's no unit-test suite yet; these are the checks used so far.

**CLI render** (fast, no UI):

```bash
node src/cli.js desktop/test/fixture.html /tmp/t.mp4 --resolution 480p --quality draft
ffprobe -v error -show_entries format=duration:stream=width,height -of compact /tmp/t.mp4
```

For finishing features, check the duration (`clip + hold`) and pull frames to compare:

```bash
ffmpeg -v error -ss 1.0 -i /tmp/t.mp4 -frames:v 1 frame.png
```

**Desktop smoke test:** opens files, clicks Convert in the real UI, saves screenshots and the videos, then quits. CI runs it on the packaged app.

```bash
cd desktop
A2V_SMOKE="test/fixture.html|/tmp/out|{\"resolution\":\"480p\",\"quality\":\"draft\",\"hold\":1,\"poster\":true}" npm start
# optional: A2V_SMOKE_WM=path/to/logo.png also turns on a watermark
# optional: A2V_SMOKE_AUDIO="a.mp3;b.m4a" fills the soundtrack list (ids smoke1, smoke2; use "audio":{"track":"smoke1"} in the options)
# optional: A2V_SMOKE_JS=path/to/script.js runs a script in the window before Convert is clicked;
#   it can drive the UI (select a queue row, type a trim) and return values, which are logged as [smoke] script
# on headless Linux: xvfb-run -a npx electron . --no-sandbox
```

Output: `ui-ready.png`, `ui-progress.png`, `ui-done.png` plus the rendered files in `/tmp/out`. Results are also written to the log (`[smoke] …` lines in `main.log`).

Example `A2V_SMOKE_JS` script, giving the first artifact its own trim:

```js
(async () => {
  document.querySelector('.item .meta').click();                 // select the first row
  const set = (id, v) => { const i = document.querySelector(id); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
  set('#trimStart', '0.5'); set('#trimEnd', '1.5');
  await new Promise((r) => setTimeout(r, 300));
  return document.querySelector('.item .chip.own')?.textContent;  // "Trim: 0.5–1.5 s"
})()
```

Saved settings persist between smoke runs (`localStorage` and `settings.json`), so pass every option a test depends on, e.g. `"trimStart":0,"trimEnd":"auto"`.

**Web UI:** run `npm run dev`, then convert the fixture and a real artifact (with sound and a start button) in each format.

**Before a release,** render a long artifact with sound at 1080p and 4K, and check: picture and sound in sync at the end, no half-drawn frames, the trimmed first frame matches the full render at the same time, and GIF frames aren't transparent with a watermark plus fades.

## Conventions

- ES modules, Node 20+, no build step, no TypeScript. Plain DOM in the UIs.
- Comments explain *why*, especially around timing, audio and FFmpeg filter order, where the reasons aren't obvious.
- Every long-running step gets a deadline (`withTimeout` / `within`) and an error message that says what was happening.
- Errors shown to users are short and actionable; details go to the log (`log()` → desktop `main.log`, or the console with `A2V_VERBOSE=1`).
- Keep `npm audit --omit=dev` clean. In `desktop/`, don't run `npm audit fix --force` (it downgrades electron-builder).
- UI copy: sentence case, plain words, no jargon in labels. No "·" separators or "→" arrows in UI text.
- Forms keep `novalidate`; validate in JS and show a readable message. Round any value written to a range input (see "Form validation is off" in [architecture](architecture.md#ui-layer)).
- The desktop window's CSP forbids inline `style="…"` attributes in markup. Set styles through the CSSOM (`el.style.x = …`, `style.setProperty`).

## Where to look when something breaks

| Symptom | Start in |
|---|---|
| Wrong length / start button not found | `pageProbe()` in `renderer.js` |
| Animation timing off, frozen or skipping | `inject.js` (clock, timers, CSS animation sync) |
| Sound missing or out of sync | `inject.js` audio shim, `collectAudio()`, audio chain in `finalize()` |
| Visual glitch only at 4K | Chromium flags in `getBrowser()` |
| Encode errors | `videoArgs()` / `finalize()` in `encode.js`; run the printed FFmpeg error by hand |
| Poster / trim preview wrong or slow | `previewFrame()` in `renderer.js`; the preview queue in `finishing.js` (`requestFrame`, `pump`) |
| Per-artifact trim / soundtrack (desktop) | `overrides` / `sharedTrim` / `selectItem` / `setLibrary` in `desktop/ui/app.js`; `perItem` and `optsFor` in the `convert` handler of `main.js` |
| Custom soundtrack silent, cut or wrong | `customAudio` in `finalize()` (`encode.js`); `probeAudio()`; `replaced` in `render()` |
| Desktop-only problems | `desktop/main.js` (paths, env vars, settings), `%APPDATA%\Artifact to Video\logs\main.log` |
