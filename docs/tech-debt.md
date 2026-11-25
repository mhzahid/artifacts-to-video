# Tech debt register

Audit date: 2026-10-11, status updated 2026-10-12. Codebase: about 2,400 lines of engine and server code, two UIs, the Electron shell and build scripts.

**Status, 2026-10-12:**
- #1, half done: all work is committed (5 commits, clean working tree). The CI workflow is still not in `.github/workflows/`, and a remote/backup isn't confirmed.
- #4, partly fixed: shared `base.css` and `finishing.js` (now also the previews and timeline). The settings-form markup is still duplicated.
- #13, partly: the READMEs link to `docs/`, but the root README still repeats the environment-variable table and CLI examples.
- New: #17 and #18 below.

**Scoring:** Impact (slows development, 1–5) · Risk (cost of not fixing, 1–5) · Effort (1 = hours, 5 = weeks). **Priority = (Impact + Risk) × (6 − Effort).** Higher means do it sooner.

## Summary

| # | Item | Type | I | R | E | Priority | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Most of the work isn't committed to git, and the CI workflow isn't in the repo | Infrastructure | 3 | 5 | 1 | **40** | 30 min |
| 2 | No CI for the web app or engine (no lint, render check or Docker build) | Infrastructure | 3 | 4 | 2 | **28** | ½ day |
| 3 | No automated tests for the render engine | Test | 4 | 5 | 3 | **27** | 2–3 days |
| 4 | Web and desktop UIs are copies that are drifting apart | Code | 3 | 3 | 2 | **24** | 1 day |
| 5 | No dependency update process; Playwright pinned in 3 places | Dependency | 2 | 4 | 2 | **24** | ½ day |
| 6 | Web app has no monitoring beyond `/healthz` | Infrastructure | 2 | 4 | 2 | **24** | ½–1 day |
| 7 | `render()` is a 200-line function doing six jobs | Code | 4 | 3 | 3 | **21** | 1–2 days |
| 8 | No linter or formatter | Code | 2 | 2 | 1 | **20** | 1 hour |
| 9 | Magic numbers: timeouts, worker split, rate limits, sizes | Code | 2 | 2 | 1 | **20** | 2 hours |
| 10 | Output filename logic exists 3 times and already differs | Code | 2 | 1 | 1 | **15** | 30 min |
| 11 | Test hooks live in production code | Code | 1 | 2 | 1 | **15** | 30 min |
| 12 | Ad-hoc desktop settings migrations | Code | 1 | 2 | 1 | **15** | 1 hour |
| 13 | Docs duplicated between READMEs and `docs/` | Documentation | 1 | 2 | 1 | **15** | 1 hour |
| 14 | In-memory job, upload and watermark state | Architecture | 3 | 3 | 4 | **12** | 3–5 days |
| 15 | GPU mode never verified on real hardware | Test | 1 | 2 | 2 | **12** | 2 hours |
| 16 | Virtual clock doesn't cover some browser timing APIs | Architecture | 2 | 3 | 4 | **10** | 2–4 days |
| 17 | Every frame preview reloads the artifact (5–7 s each) | Performance | 2 | 1 | 3 | **9** | 1–2 days |
| 18 | Per-artifact trims live only in the desktop window | Code | 1 | 1 | 2 | **8** | 2 hours |

---

## Details

### 1. Work not committed; CI workflow missing from the repo (priority 40)

**Evidence:** the repo on disk has 2 commits. 21 files are modified and 3 are untracked (`docs/`, `public/finishing.js`, `desktop/scripts/make-test-cert.ps1`): everything since the first version, including presets, finishing, watermark, signing and the docs. There's no `.github/` folder. The workflow files (`desktop-windows.yml`, `desktop-windows-1.yml`) sit in `Claude outputs/`, so GitHub never runs them.

**Why it matters:** one bad checkout or disk problem loses weeks of work, there's no way to bisect a regression, and the documented "build on GitHub" path doesn't actually exist.

**Fix:** commit in logical chunks (engine finishing features · web UI · desktop UI and signing · docs). Move the newest workflow to `.github/workflows/desktop-windows.yml`. Delete the old copies and `Claude outputs/` (or add it to `.gitignore`). Push to a private remote.

### 2. No CI for the web app and engine (priority 28)

**Evidence:** the only workflow (not yet in the repo) builds the desktop installer. Nothing checks the engine, the server or the Docker image on each change.

**Fix:** add `.github/workflows/web.yml` that runs on push and PR: `npm ci`, lint, `node --check`, the engine tests from #3, and `docker build`. About 10 minutes on `ubuntu-latest` with FFmpeg installed.

### 3. No automated tests for the render engine (priority 27)

**Evidence:** no `test` script anywhere. Correctness is checked by hand (ffprobe durations, frame comparisons, smoke screenshots). The engine's hardest guarantees, exact timing, audio sync, seamless worker joins and the finalize filter order, are exactly the ones that regress silently. Past bugs that tests would have caught: transparent GIF frames with watermark plus fades, disconnect erasing offline audio, half-drawn 4K frames.

**Fix:** `node --test` (built in, no new dependency) with three layers:

- **Unit (fast):** `normalizeOptions()` clamping and defaults, `outputSize()`, trim frame maths, and the `finalize()` argument builder (extract a pure `buildFinalizeArgs()` from #7 and snapshot its filter graph).
- **Golden renders (about 1 min):** small fixtures, each covering one case: a CSS animation, a GSAP timeline with a start button, Web Audio with `disconnect()`, `<audio>` element, and a long busy-wait. Render at 480p draft and assert duration, frame count and audio peak position. Compare 2 workers against 1 worker to prove segments join identically. Check a trimmed first frame against the full render at the same time.
- **Desktop smoke:** already exists (`A2V_SMOKE`); run it in CI (#2).

### 4. Web and desktop UIs are drifting copies (priority 24), partly fixed

**Update (redesign):** the stylesheet is now split into a shared `public/base.css` (synced to the desktop) plus small per-app layout files, and the output timeline lives in `finishing.js`. Still duplicated: the settings-form markup in the two `index.html` files and the options/refresh logic in the two `app.js` files.

**Evidence:**

- `desktop/ui/app.css` contains all 159 lines of `public/app.css` plus 67 more. Every web style fix has to be made twice.
- The two `index.html` files share 122 of about 175 lines (settings form, Advanced panel); only the finishing logic is shared (`finishing.js`).
- Drift has already started: the `STAGES` labels differ ("Inspecting artifact" vs "Inspecting", "Capturing frames" vs "Capturing"), and the web table has no `poster` / `audio` entries.

**Why now:** Templates adds a dynamic variable form and a CSV batch screen to both apps. Building it twice doubles the work and the bugs.

**Fix:**

- Split the CSS into `public/base.css` (shared, synced) plus `app.css` (web) and `desktop.css` (overrides).
- Move the settings-form markup and its options/apply/refresh logic into a shared `public/settings.js` that renders into a container (like `finishing.js`), and move the shared stage labels there.
- Extend `sync-engine.mjs` to copy these files.

### 5. Dependency updates (priority 24)

**Evidence:** Playwright `1.56.0` is pinned in `package.json`, `desktop/package.json` and the Dockerfile (`playwright:v1.56.0-noble`), and the three must change together. Electron ships security fixes frequently and supports only its latest few majors. There's no Dependabot or Renovate. Express is on 4.x.

**Fix:**

- Add `.github/dependabot.yml` (npm for `/` and `/desktop`, docker, github-actions), grouped weekly.
- Add a tiny check script that fails CI if the three Playwright versions differ.
- Plan the Express 5 move when convenient; the API surface used here is small.

### 6. Web monitoring (priority 24)

**Evidence:** `console.log` / `console.error` only. `/healthz` checks only that the browser starts. Nothing tracks render failures, queue length, render time or `storage/` disk usage. A full disk or a crash loop would go unnoticed.

**Fix:**

- One JSON log line per job (id, options, duration, frames, captureFps, status, error).
- Add disk free space and queue length to `/healthz`.
- An uptime monitor on `/healthz`, (`docker-compose.yml` already restarts the container with `restart: unless-stopped`).
- Optional: Sentry, or the error tracker you already use.

### 7. `render()` is a god function (priority 21)

**Evidence:** `src/render/renderer.js` is 526 lines. `render()` runs about 200 lines (lines 295–492) covering planning (trim, worker split), the per-worker capture closure (page setup, start, fast-forward, frame loop, audio), concatenation, finalize, poster and the result object. `finalize()` in `encode.js` mixes graph building with running FFmpeg.

**Why now:** the roadmap features hook in here: Templates (variable injection per worker), multi-format export (one capture, many finalizes), speed control and loop export (finalize), and custom audio (finalize).

**Fix:** keep the behaviour and split into:

- `planRender(opts, info)` → frames, ranges, `post`
- `captureSegment(k, plan)`
- `assemble(segments)`
- `finalize(plan, outputs[])`
- `buildFinalizeArgs()`, a pure function so it can be unit-tested

Do it right after #3's golden tests exist, so the refactor is safe.

### 8. No linter or formatter (priority 20)

**Fix:** ESLint (flat config, `eslint:recommended`, browser globals for `public/` and `inject.js`) plus Prettier, with `npm run lint` wired into CI. It catches unused variables and accidental globals, which matters especially in `inject.js`, which runs inside untrusted pages.

### 9. Magic numbers (priority 20)

**Evidence:**

- Timeouts `60000`, `120000`, `180000`, `300000` scattered through `renderer.js`.
- The worker split `frames / 45`.
- JPEG quality `94`, watermark limit `5 * 1024 * 1024`, rate limits `30/10`, `20/10`.
- Housekeeping interval `5 * 60_000`.

**Fix:** a `const TUNING = {…}` block at the top of `renderer.js` and `server.js` with a comment per value. Make the rate limits configurable through environment variables for hosting.

### 10. Output filename logic in three places (priority 15)

**Evidence:** `slug()` is written out in `server.js` twice (download and poster) and once in `desktop/main.js`, and they already differ: the desktop strips everything after `|` in the title, the web doesn't. The same artifact downloads as `keep-the-mvp-lose-the-ceiling-codixel-1080p-30fps.mp4` on the web and saves as `keep-the-mvp-lose-the-ceiling-1080p-30fps.mp4` on the desktop.

**Fix:** move `outputName(title, opts, ext)` into `presets.js` (synced to the desktop) and use it in all three places. Templates needs a filename pattern (`{client}-{resolution}`) anyway, and this is where it belongs.

### 11. Test hooks in production code (priority 15)

**Evidence:** `A2V_SMOKE` / `A2V_SMOKE_WM` in `desktop/main.js` and `window.__a2vTest` in `desktop/ui/app.js` ship in the installer. Risk is low (it needs local environment variables), but it's surface area.

**Fix:** keep them, because CI tests the packaged app. Group them in one `test-hooks.js` module, and only expose `__a2vTest` when the main process says smoke mode is on.

### 12. Ad-hoc settings migrations (priority 15)

**Evidence:** `loadSettings()` has an inline `if ((settings.settingsVersion || 1) < 3)` patch. The next change adds another `if`.

**Fix:** a small ordered `MIGRATIONS = [{ to: 3, run(s) {…} }]` list that runs in sequence.

### 13. Duplicated docs (priority 15)

**Evidence:** the root README still has the full environment variable table, CLI examples and performance notes, which now also live in `docs/` (`cli.md`, `architecture.md`). Outdated docs are worse than none, and this already happened once: the README described the watermark API wrongly.

**Fix:** keep the READMEs to setup and deploy, and link to `docs/` for reference material. Keep the environment variable table only in `docs/` and the README's deploy section.

### 14. In-memory state (priority 12)

**Evidence:** jobs (`JobQueue`), uploads and watermarks are `Map`s in one process. A restart or deploy drops queued and running jobs and their downloads (startup deletes `storage/`). Only one server can run.

**When it matters:** hosted accounts and history, quotas, shareable links, and large Templates batches. That's the hosted roadmap, not today.

**Fix:** BullMQ + Redis for the queue (the `JobQueue` API was designed to be swappable: create / get / cancel / subscribe) and SQLite or Postgres for uploads, jobs and users. Outputs go to S3-compatible storage with signed URLs. Scope this together with accounts, not before.

### 15. GPU mode unverified (priority 12)

**Evidence:** `ENABLE_GPU` / the desktop toggle has only been tested with software rendering. Real-GPU output may differ (colour, timing of compositor stages) or be slower.

**Fix:** on a Windows PC with a GPU, render the sample with GPU on and off, then compare speed (frames/s on the finished row) and frames (`ffmpeg -lavfi psnr`). Keep it experimental, or make it the default where it's faster.

### 16. Virtual clock coverage gaps (priority 10)

**Evidence:** `inject.js` virtualises `performance.now`, `Date`, rAF, timers, CSS/WAAPI animations and media. It doesn't touch `MessageChannel` / `postMessage` scheduling, Web Workers (their own clocks), `requestIdleCallback`, `requestVideoFrameCallback` or AudioWorklet timing. Artifacts that use them could render with wrong timing.

**Fix:** handle these as they show up. Add a fixture per API to the golden tests (#3), add the cheap shims (`requestIdleCallback` → timer, `requestVideoFrameCallback` → rAF), and record the rest under "Known limits" in the user guide.

---

### 17. Every frame preview reloads the artifact (priority 9)

**Evidence:** `previewFrame()` opens a fresh page, waits for the start button and fast-forwards for every preview, about 5–7 s on 2 vCPU. Dragging a trim or poster slider therefore feels slow, even though finished frames are cached.

**Fix:** keep one warm page per artifact and preview settings. Moving forward in time only needs `goTo()` (milliseconds); moving backward reloads. Close idle pages after a minute. Worth doing if scrubbing becomes a core workflow, e.g. for the planned timeline preview.

### 18. Per-artifact trims live only in the desktop window (priority 8)

**Evidence:** the overrides map is in `desktop/ui/app.js` memory. Reloading the window (Ctrl+R) or restarting loses them, while the queue items themselves are rebuilt from the main process.

**Fix:** keep them on the item in `main.js` (sent along with `item` updates), so they survive reloads and could later be saved with the queue.

---

## Remediation plan (alongside feature work)

**Phase 0: today (about 1 hour)**

- #1 Commit everything, move the workflow into `.github/`, push.
- #8 Add the linter and formatter, then run them once.

**Phase 1: before Templates (about 1 week, interleaved)**

- #2 + #5 Web CI and Dependabot.
- #3 Unit tests and golden render tests.
- #10 Shared `outputName()`; extend it with patterns for Templates.
- #4 Shared base CSS and settings module, so the Templates form is built once.
- #7 Split `render()` once the golden tests are green. Templates' variable injection then plugs into `captureSegment`.
- #9, #11, #12 in passing while touching those files.

**Phase 2: before public hosting**

- #6 Monitoring and logging.
- #13 Trim the README duplication.
- #15 GPU check on real hardware.

**Phase 3: with accounts and the hosted roadmap**

- #14 Persistent queue, database and object storage.
- #16 Clock coverage, driven by real artifacts that break.

**Rule of thumb from here on:** every new feature adds at least one golden render test, and a file is tidied (magic numbers, duplication) when a feature touches it.
