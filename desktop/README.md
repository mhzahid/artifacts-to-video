# Artifact to Video: desktop app (Windows)

An Electron app that converts HTML artifacts to MP4, WebM, MOV (ProRes) or GIF on your own PC. It uses the same render engine as the web version (`../src/render`), so output is identical. It has no upload limits, works offline for self-contained artifacts, and the files never leave your machine.

## What's inside

| Part | Choice |
|---|---|
| Shell | Electron 44. The window UI talks to the main process over a small, sandboxed IPC bridge (`preload.cjs`) |
| Capture | Playwright with **bundled headless Chromium** (`resources/browsers`). If it is missing it falls back to installed Edge, then Chrome |
| Encoding | **ffmpeg-static** (bundled `ffmpeg.exe`) |
| Engine | `engine/` is copied from `../src` by `npm run sync`, so web and desktop always run the same code |
| Installer | electron-builder → NSIS `.exe` (per-user install, lets you pick the folder, Start menu and desktop shortcuts) |

## Features

- **Add files:** drag and drop HTML artifacts, or use **Add artifacts**. Each file is inspected for its length and start button, and a poster frame is shown.
- **Batch queue:** convert many files in a row, with progress, frame count and ETA per file, and cancel one or all. Click a row to select it: the timeline and previews show that artifact, and its trim, soundtrack and poster frame can be set on their own.
- **Export settings:** format, resolution (480p–4K), aspect ratio, fps, quality, sound on/off, duration, plus advanced start and hide options.
- **Presets:** YouTube 1080p / 4K, Reels / Shorts (9:16), Feed (4:5), Square, Website background, GIF, Master (ProRes), Quick preview.
- **Soundtrack:** add audio files once (they stay in the list between sessions) and pick one per artifact or for all: replace the artifact's sound or mix with it, volume, loop. The row shows a chip like **Audio: intro.mp3**.
- **Trim** (start/end time; click an artifact in the queue to give it its own trim and poster frame) and **Fades & ending:** fade in at the start; hold the last frame (1–5 s, sound keeps playing) and fade out at the end.
- **Watermark:** choose a PNG/JPG/WebP logo once (remembered between sessions), with position, size (labels show the real pixel size) and an opacity slider. The logo preview fades with the slider.
- **Poster image:** saves a PNG beside each video, with a live preview of the chosen frame; the image button on a finished row opens it.
- **Output timeline:** shows what the video will contain (trim, held frame, fades, poster pin); clicking its Video lane picks the poster frame.
- **Output:** saves to `Videos\Artifact to Video` by default (change it with **Change**). Files are named automatically and never overwrite each other.
- **Windows integration:** one combined title bar (the app header, with Windows' own window buttons), progress on the taskbar icon, a notification when a video is ready, **Play** / **Show in folder** buttons, and a right-click menu for copying text and editing fields.
- **App settings:** number of render workers (parallel pages; default is one per CPU core, max 4), **Use graphics card (GPU)** (experimental speed-up), notifications, open folder when done, and allow local network. Finished videos show their capture speed in frames/s so you can compare settings.
- **Relative assets:** `./images/…` next to the HTML file load correctly.
- **Command line:** start it with file paths to queue them, e.g. `"Artifact to Video.exe" a.html b.html`.

## Develop

```bash
cd desktop
npm install
npm start            # syncs ../src into engine/ and opens the app
```

`npm start` uses Playwright's normal browser cache. Run `npx playwright install chromium --only-shell` once if Chromium is missing.

## Build the installer

On Windows (Node 20+):

```bash
cd desktop
npm install
npm run dist         # → desktop/dist/Artifact-to-Video-Setup-1.0.0.exe (unpacked app in dist/build-<time>/win-unpacked)
```

`npm run dist` syncs the engine, downloads headless Chromium into `desktop/browsers`, and runs electron-builder. Expect an installer of roughly 180 MB (see "Installer size" below).

Or let GitHub build it: push a tag such as `desktop-v1.0.0`, or run **Actions → Desktop app (Windows) → Run workflow**. The workflow (`.github/workflows/desktop-windows.yml`) builds on `windows-latest`, smoke-tests the packaged app by converting `test/fixture.html`, uploads the installer as a build artifact, and attaches it to the release for tags.

### Code signing

Without a signature, Windows shows "Windows protected your PC" (SmartScreen) and "Unknown publisher". `npm run dist` signs automatically when one of these is configured through environment variables. No secrets are stored in the repo.

| Method | Set these variables | Notes |
|---|---|---|
| **Azure Artifact Signing** (formerly Trusted Signing) | `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`, plus a service principal: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Monthly subscription. Microsoft verifies your identity. Availability depends on your country and whether you sign as a company or an individual, so check Microsoft's current eligibility rules first. |
| **Certificate in the Windows certificate store** (USB token, Certum SimplySign, or another cloud signing service that shows up as a virtual smart card) | `WIN_CERT_SHA1` = the certificate's thumbprint; optionally `WIN_CERT_PUBLISHER` | For OV/EV certificates bought from a certificate authority (Certum, Sectigo, SSL.com, DigiCert…). Since mid-2023 their keys must live on hardware or in the cloud, so you can't export them as a `.pfx`. |
| **PFX file** | `CSC_LINK` (path or base64), `CSC_KEY_PASSWORD` | For a self-signed test certificate, or an older exportable certificate. |

- `A2V_REQUIRE_SIGNING=1` makes the build fail instead of silently producing an unsigned installer. Use it for releases.
- electron-builder signs the app `.exe`, `ffmpeg.exe`, the capture browser's `headless_shell.exe` and the installer, all with an RFC 3161 timestamp, so signatures stay valid after the certificate expires.
- On Windows, `npm run dist` prints each file's signature status at the end.
- **Test the pipeline first:** `powershell -ExecutionPolicy Bypass -File scripts\make-test-cert.ps1` creates a self-signed certificate and prints its thumbprint. Set `WIN_CERT_SHA1` to it and build. Self-signed only proves the setup works; it does not remove SmartScreen for other people.
- **SmartScreen reputation:** even a properly signed installer can show a warning until enough people have downloaded it. That reputation belongs to your certificate/publisher identity, so keep using the same one.
- **GitHub Actions:** the workflow reads the same variables from repository secrets (`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` for a PFX, or the `AZURE_*` group).

## Installer size

The build trims what the app never uses:

- **Electron's 55 interface languages:** only `en-US` is kept.
- **DirectX shader compiler** (`dxcompiler.dll`, `dxil.dll`): only needed for WebGPU, which the app's window doesn't use. Set `A2V_KEEP_DXC=1` to keep them.
- **Playwright's own FFmpeg build and dependency checker:** not needed for capture.
- **Unused package files:** source maps, type definitions, docs and Playwright's trace-viewer UI.

The compressed app payload went from 143 MB to 126 MB, about 17 MB smaller (measured without Chromium). Your installer should drop from about 199 MB to about 180 MB. The rest is three large parts: Electron itself, the capture browser (Chromium, about 60 MB compressed) and FFmpeg (about 25 MB compressed). Removing the second copy of Chromium would mean capturing with Electron's own Chromium instead, a bigger change to the engine.

## Troubleshooting

- **System check:** the app checks FFmpeg and the capture browser at startup. If either fails, a red banner names the problem and links to the log, `%APPDATA%\Artifact to Video\logs\main.log`, which records every render step. The full check (versions, graphics renderer, **Open log file**, **Run check again**) appears under **App settings** in development (`npm start`), or in the installed app when started with `A2V_DEBUG=1`:

  ```bat
  set A2V_DEBUG=1
  "%LOCALAPPDATA%\Programs\Artifact to Video\Artifact to Video.exe"
  ```
- **A render stuck on "Loading renderers"** used to mean FFmpeg couldn't start. Renders now fail within seconds with the reason instead of waiting forever.
- **FFmpeg missing.** Some npm setups skip packages' install scripts (`npm config get ignore-scripts` → `true`, or newer npm defaults), so `ffmpeg-static` never downloads `ffmpeg.exe`. `npm run ensure` (it also runs after `npm install`, and before `start` and `dist`) downloads it. A build hook (`scripts/after-pack.cjs`) refuses to produce an installer without FFmpeg or Chromium inside.

- **`EBUSY: resource busy or locked … app.asar`** came from replacing a previous build that something still had open (a running `Artifact to Video.exe` from `win-unpacked`, its `headless_shell.exe`, or another Electron app such as VS Code or the Claude desktop app that opened `app.asar`). Local builds now go into a fresh `dist\build-<date>-<time>\` folder every time. The installer is copied to `dist\`, and older build folders are deleted once nothing has them open.

## Test hook

`A2V_SMOKE="file1.html;file2.html|<outDir>|{json options}"` opens the files, clicks **Convert** in the real UI, saves screenshots plus the videos to `<outDir>`, and quits. The CI workflow uses it. `A2V_SMOKE_WM=logo.png` also turns on a watermark for the test, `A2V_SMOKE_AUDIO="a.mp3;b.m4a"` fills the soundtrack list (ids `smoke1`, `smoke2`), and `A2V_SMOKE_JS=script.js` runs a script in the window before Convert is clicked (for example to select a row and set its own trim).

## Roadmap

**Next up: Templates / variables** (one artifact → many personalised videos, CSV rows become queue items). Full plan in the [main README](../README.md#roadmap). Desktop-specific items: watch folder, auto-update, and sending renders to your own VPS.
