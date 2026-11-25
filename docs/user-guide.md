# User guide

Artifact → Video turns an animated HTML file (a Claude artifact, a GSAP / CSS / Canvas / SVG motion piece) into an **MP4, WebM, MOV (ProRes) or GIF**. It plays the animation on a virtual clock and captures it frame by frame, so nothing is dropped and the sound stays in sync, even at 4K on a slow machine.

There are two apps with the same settings and identical output:

- **Web app:** open the site, drop a file, download the video. Files are deleted after an hour.
- **Desktop app (Windows):** converts on your own PC, with a batch queue, no upload limit, and files that never leave your machine.

---

## Quick start

### Web app

1. Drop your `.html` file on the left panel, or click it to choose one (25 MB max by default).
2. Wait a moment while the artifact is opened. You'll see a preview frame plus its length and how it starts (for example `54.5 s` · `starts: Play with sound`).
3. Pick a **Preset**, or set Format, Resolution and the rest yourself.
4. Click **Convert**. Progress shows the frame count, capture speed and time left. **Cancel** stops it.
5. When it's done, preview the video and click **Download** (and **Poster image** if you asked for one).

### Desktop app

1. Drag one or more HTML files into the window, or click **Add artifacts**.
2. Choose the settings on the right. They apply to every file you convert. To give one artifact its own trim or poster frame, click its row first (see [Different trims in one batch](#different-trims-in-one-batch-desktop-app)).
3. Click **Convert**. Files are processed one after another. Each row shows its progress, and you can cancel one or all.
4. Finished rows have buttons to **play** the video, open the **poster image**, **show in folder**, and remove the row.

Videos are saved to `Videos\Artifact to Video` unless you click **Change** next to "Save to". Files are named `<title>-<resolution>-<fps>fps.<ext>` and never overwrite an existing file.

You can also start the app with files: `"Artifact to Video.exe" a.html b.html`.

Right-click any text (file names, paths, error messages) to **Copy** it, and right-click an input field for Cut / Copy / Paste. The top bar is the window's title bar: drag it to move the window and double-click it to maximize.

---

## Settings

### Preset

One click fills Format, Resolution, Aspect ratio, Frame rate, Quality and sometimes Sound. If you change any of those fields afterwards, the dropdown switches to **Custom**.

| Preset | Format | Size | Aspect | fps | Quality | Notes |
|---|---|---|---|---|---|---|
| YouTube · 1080p | MP4 | 1920×1080 | 16:9 | 30 | Standard | |
| YouTube · 4K | MP4 | 3840×2160 | 16:9 | 30 | High | Slowest; best detail |
| Reels / TikTok / Shorts | MP4 | 1080×1920 | 9:16 | 30 | Standard | |
| Instagram / Facebook feed | MP4 | 1080×1350 | 4:5 | 30 | Standard | |
| LinkedIn / X square | MP4 | 1080×1080 | 1:1 | 30 | Standard | |
| Website hero | WebM | 1920×1080 | 16:9 | 30 | Standard | Sound off, for autoplaying background video |
| GIF for chat / email | GIF | 854×480 | 16:9 | 24 | Standard | |
| Editing master | MOV ProRes | 1920×1080 | 16:9 | 30 | High | For Premiere, Final Cut, DaVinci Resolve |
| Quick preview | MP4 | 1280×720 | 16:9 | 24 | Draft | Fast check before the real render |

### Format

| Format | Video / audio | Use it for |
|---|---|---|
| **MP4** | H.264 + AAC | Everything: social media, websites, sharing. The safe default |
| **WebM** | VP9 + Opus | Websites (smaller files at the same quality) |
| **MOV · ProRes** | ProRes 422 + PCM | Editing. Very large files, best quality. Draft = Proxy, Standard = 422, High = 422 HQ |
| **GIF** | No sound | Chat, email, docs. Limited to 720p and 30 fps |

### Resolution and aspect ratio

Resolution is the **short side** of the video: 1080p is 1920×1080 in 16:9 and 1080×1920 in 9:16. Options run from 480p to 2160p (4K); the web host can cap the maximum.

Aspect ratio changes the page size the artifact is laid out at (16:9 = 1920×1080, 9:16 = 1080×1920, 1:1 = 1080×1080, 4:5 = 1080×1350). A responsive artifact rearranges itself to fit. A fixed-size artifact may be cropped or letterboxed by its own CSS.

Higher resolutions are drawn sharper, not upscaled: a 1080-wide layout rendered at 4K is drawn at 2× pixel density. Lower resolutions do **not** render faster. See [Speed](#speed).

### Frame rate

24, 25, 30 or 60 fps. 30 is the standard choice. 60 is smoother for fast motion but takes twice as long as 30. 24 gives a film look and 20% fewer frames than 30.

### Quality

| Quality | What changes |
|---|---|
| Draft | Faster encoding, smaller file, visible compression on gradients |
| Standard | Good for anything you publish |
| High | Lossless PNG capture and a high-quality encode. Use it for 4K, ProRes, or artifacts with fine gradients and text |

### Duration

**Auto** uses the length the converter detected (from a GSAP timeline, CSS animations, media, or a hint in the file). Type a number in seconds to override it, for example when an animation loops forever. The maximum is 300 s by default.

### Sound

On by default. The converter records everything the artifact plays through Web Audio, plus `<audio>` and `<video>` elements, in sync with the picture. Turn it off for silent videos; this also starts the render a few seconds sooner. GIFs never have sound.

### Soundtrack

Use your own music or voice-over instead of (or together with) the artifact's sound.

1. Open **Soundtrack** and click **Add audio…**. You can choose several files at once: MP3, WAV, M4A, AAC, OGG, FLAC or Opus (web app: up to 30 MB each). Each file is checked and listed with its length. The first file you add becomes the track.
2. Pick the track in **Audio track**, or click **Use** next to a file. **The artifact's own sound** goes back to normal.
3. **Use it to:** **Replace the artifact's sound** (only your track is heard; the artifact's audio isn't even recorded) or **Mix with the artifact's sound** (both play).
4. **Volume:** 0–100% for your track. **Loop:** repeats the track if it's shorter than the video; without it, the rest of the video is silent. A note tells you when the track is shorter.

The track starts with the first frame of the video, whatever the trim, and is cut at the end of the video (including a held last frame). **Fade in / Fade out** apply to it as well. The output timeline gets an **Audio** lane showing how long the track plays, with a tick at each loop.

The Soundtrack needs **Sound** on, and isn't used for GIFs. Remove a file from the list with **×**. In the web app the list lasts until you reload the page (uploads are deleted after an hour); in the desktop app it's remembered, and only the file's location is stored, so don't move or delete the original.

---

## Trim, fades & ending

Two panels: **Trim** (Start at, End at) and **Fades & ending** (fade in at the start; hold the last frame and fade out at the end; fade length). Their badges show what's active, for example `2–12 s` on Trim and `+2s, fade` on Fades & ending.

### Output timeline

Above the **Convert** button, the **Output** timeline shows what the video will contain, and it updates as you change settings:

- **Source** is the whole animation. The green window is the part you're keeping (Start at to End at).
- **Video** is the finished video on the same time scale: the green clip, a striped block for the held last frame, dark ramps for fades, and a pin for the poster frame.
- Above the lanes: the final length and how many frames will be captured. Below them: the in and out times and a one-line description.

In the desktop app the timeline shows the first artifact in the queue; the settings apply to all of them.

### Trim

- **Start at:** seconds into the animation where the video begins. Empty = 0.
- **End at:** seconds into the animation where it ends. Empty = the end.

Trimming is exact: the animation still plays from the beginning in the background, so the first frame looks exactly as it would in the full video, and the sound is cut to match. Frames outside the trim aren't captured, so trimmed renders are faster.

Example: a 54.5 s animation trimmed to **Start 10** and **End 25** gives a 15 s video.

**Seeing the trim:** under Start at / End at, the Trim section shows the **first frame** and the **last frame** the video will contain, rendered from your artifact, with their exact times (the last frame is the one just before End at). Drag the slider under either frame to move the trim point; the field updates with it. Dragging the end slider all the way right removes the end trim. Each frame takes a few seconds to render, and frames you've already seen come back instantly.

### Different trims and soundtracks in one batch (desktop app)

Settings in the desktop app apply to every artifact in the queue. Trim, the poster frame and the soundtrack can also be set per artifact:

1. **Click an artifact** in the queue. It's highlighted, and the Soundtrack, Trim and Poster image sections show "For *name* only". The output timeline and poster preview switch to that artifact.
2. **Set Start at / End at** (and the poster frame), or **choose its soundtrack**. The row gets a chip like **Trim: 2–12 s** or **Audio: intro.mp3**.
3. **Click the artifact again, press Esc, or click Done** to go back to the shared settings, which apply to all the others.

In the note above the fields: **Use for all artifacts** copies this artifact's trim, poster frame and soundtrack to the whole queue, and **Use the shared settings** removes its own. Everything else (format, resolution, fades, watermark…) is always shared. A soundtrack chosen for one artifact includes its replace/mix, volume and loop settings. Before converting, each artifact's trim is checked against its own length. If one is wrong, that artifact is selected and the problem is named.

### Hold last frame

Freezes the final frame for 1, 2, 3 or 5 seconds. This is useful as an end card with a logo or call to action. The soundtrack keeps playing underneath, so a closing note can ring out.

### Fade in / fade out

- **Fade in:** from black, picture and sound together.
- **Fade out:** to black at the very end (after any hold).
- **Fade length:** 0.3, 0.5, 1 or 2 seconds, used by both fades.

Final length = (End − Start) + Hold.

---

## Watermark

Open the **Watermark** panel and turn on **Add logo / watermark**, or click **Choose image…**.

- **Image:** PNG, JPG or WebP. A PNG with a transparent background looks best. Web uploads are limited to 5 MB. The desktop app remembers your logo between sessions.
- **Position:** bottom right (default), bottom left, top right, top left, or center. Corner logos sit 4% of the short side in from the edges.
- **Size:** the logo's width as a share of the video's width: Small 8%, Medium 12%, Large 18%, X-large 25%. Each option shows the resulting size in pixels for the current resolution and aspect ratio, for example **Medium (230 × 77 px)** for a 3:1 logo in a 1920×1080 video. The height follows your logo's shape.
- **Opacity:** slider from 10% to 100% (default 85%).

The watermark is burned into every frame, including held frames, and fades with the picture.

---

## Poster image

Open the **Poster image** panel and turn on **Save a poster image** to get a PNG of one frame. Use it as a YouTube thumbnail, a `<video poster>` image, or a cover image.

- **Preview:** the panel shows the frame you've picked, rendered from your artifact exactly as the video will show it, with your trim applied, darkened if it falls inside a fade, and with the watermark where the video will have it. Each preview takes a few seconds to render; a spinner shows while it updates.
- **Choosing the frame:** drag the slider under the preview, type seconds into **Frame at**, or click anywhere on the **Video** lane of the output timeline. All three are seconds into the *finished* video. Empty = the middle. A time inside the held last frame shows that last frame.
- The poster includes the watermark. For GIFs it's taken from the full-colour frame, not the 256-colour GIF.
- **Web:** a **Poster image** button appears next to Download.
- **Desktop:** saved next to the video with the same name and a `.png` extension. Use the image button on the finished row to open it. The preview shows the artifact selected in the queue, or the first one if none is selected.

---

## Advanced

| Setting | What it does |
|---|---|
| **Start mode** | **Auto-detect** (default) clicks a start button if one was found, otherwise records from page load. **Click a start button** forces clicking. **Plays on load** records from the first moment without clicking anything |
| **Start button** | A CSS selector for the button to click, if auto-detect picks the wrong one, e.g. `#play` |
| **Hide elements** | CSS selectors for things to keep out of the video, e.g. `#ui, .controls` |
| **Auto-hide player controls** | Hides sliders and player control bars automatically (on by default) |
| **Color scheme** | Light or dark, for artifacts that follow `prefers-color-scheme` |

Many artifacts have a "Play with sound" button, because browsers only allow audio after a click. Auto-detect looks for visible buttons whose text mentions play, start, begin, watch and so on, and prefers ones that mention sound. The button itself is hidden from the video.

## Desktop app settings

Open **App settings** at the bottom of the settings panel.

| Setting | Default | Meaning |
|---|---|---|
| Render workers | One per CPU core, max 4 | Browser pages that capture parts of the video at the same time. More = faster, until the CPU is full |
| Use graphics card (GPU) | Off | Experimental. Can speed up drawing on PCs with a real graphics card |
| Notify when a video is ready | On | Windows notification per finished video |
| Open the folder when the queue finishes | Off | |
| Allow local network | Off | Lets artifacts load files from `localhost` or your LAN (e.g. a Laragon site or dev server). Keep it off for artifacts you didn't make: their code could otherwise reach your router, NAS or local services |
| Version | | The app version and how many CPU cores it found. The full **System check** (FFmpeg, browser, graphics) appears here in development, or when the app is started with `A2V_DEBUG=1` |

Finished rows show the capture speed in frames per second, so you can compare settings.

---

## Making artifacts render well

Most artifacts work without changes. If you author your own, these hints make detection exact:

```html
<meta name="a2v:duration" content="54.5">     <!-- length in seconds -->
<meta name="a2v:start" content="#startSnd">   <!-- the button that starts it (with sound) -->
<meta name="a2v:hide" content="#ui, .hint">   <!-- elements to keep out of the video -->
```

You can also set `window.A2V_DURATION = 54.5` in a script. A paused GSAP timeline exposed as `window.film` is detected automatically, and so is a length constant in an inline script, such as `const DUR = 30` (also `DURATION`, `TOTAL`, `LENGTH`, or `DURATION_MS = 30000` in milliseconds).

Good practice:

- **Drive animation from time,** not from frame counts: GSAP, CSS animations, Web Animations, or `requestAnimationFrame` with its timestamp. All of these follow the virtual clock.
- **Use Web Audio or `<audio>` for sound.** Both are captured. Microphone or `MediaStream` audio, and cross-origin `<audio>` without CORS headers, are not.
- **Lay out for the aspect ratio you'll export,** or make the layout responsive.
- **Keep assets loadable:** web fonts and CDN scripts are fine. In the desktop app, relative files next to the HTML (`./images/logo.png`) also load. On the web app, only the single uploaded file is available, so inline small images as `data:` URLs.
- **Avoid needing user input.** Hover and scroll effects render in their resting state.
- **WebGL / 3D canvas (three.js and similar)** works, but without a graphics card each frame is drawn on the CPU: a heavy scene can take several seconds per frame at 1080p. The queue row shows **WebGL: slow without GPU**. In the desktop app, turn on **Use graphics card (GPU)** in App settings; for a quick look, render at 480p or 720p (WebGL artifacts are captured at the output size, so smaller is much faster).
- **Don't adapt quality to frame rate while recording.** Some artifacts lower their own resolution when frames seem slow. Under the converter every frame arrives exactly 1/fps apart (33 ms at 30 fps), which such code reads as a slow device, so the video gets blurrier as it plays. Skip that logic when `window.__a2v` exists (the converter defines it before the page's scripts run): `if (!window.__a2v) { /* adaptive resolution */ }`.

---

## Speed

Each frame is drawn by Chromium and captured as an image. At 1080p that costs about 150 ms of CPU per frame per browser page. A 55 s animation at 30 fps is 1,650 frames.

To render faster:

- **More workers / CPU cores.** Throughput grows almost linearly with cores. Desktop: App settings → Render workers.
- **Fewer frames.** 24 fps instead of 30, or trim to the part you need.
- **Sound off** saves a few seconds of setup.
- **Quick preview** preset to check timing before the final render.
- **GPU** (desktop, experimental) on PCs with a real graphics card.

Picking 720p instead of 1080p barely helps: pages are always drawn at their full layout size, which keeps text sharp, and then scaled down. 1440p and 4K draw more pixels and are slower: a 4K render takes about 4× as long as 1080p.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not detect the animation length" | Type a **Duration**, or add `<meta name="a2v:duration" content="…">` to the file |
| WebGL / three.js artifact converts very slowly or seems stuck | It's drawn on the CPU. Turn on **Use graphics card (GPU)** (desktop), or render at 480p / 720p first. Watch the frames/ETA in the row: it's progressing, just slowly |
| WebGL video looks softer or blockier in dark areas than the browser | Use **High** quality. WebGL scenes are already encoded with settings for grainy, dark footage; MOV (ProRes) keeps the most detail for editing |
| WebGL video gets blurry after a few seconds | The artifact lowers its own resolution when it thinks the device is slow. See "Don't adapt quality to frame rate" above |
| Video starts before or after the animation | Set **Start mode**, or give the exact **Start button** selector |
| A play button or control bar appears in the video | Add its selector to **Hide elements**, or check **Auto-hide player controls** is on |
| No sound | Check Sound is on and the format isn't GIF. Sound from a microphone, `MediaStream` or cross-origin audio without CORS can't be captured |
| Fonts or images missing | The asset must be loadable from the web (or, in the desktop app, sit next to the HTML file). Requests to `localhost` or private networks are blocked unless **Allow local network** is on (desktop) |
| "End at must be after Start at" | Trim values are seconds into the animation; End must be greater than Start, and Start less than the length. In a desktop batch the message names the artifact, and an artifact with its own trim is selected so you can fix it |
| A preview says "Rendering preview…" for a while | Each frame preview loads your artifact and plays it up to that moment, which takes a few seconds (longer for long animations). Previews only render while their panel is open |
| "The watermark image has expired" (web) | Uploaded images are kept for an hour. Choose the image again |
| "The render queue is full" (web) | The server is busy; try again in a few minutes |
| "The render browser crashed (out of memory?)" | Try a lower resolution, fewer workers, or Draft quality |
| Desktop: stuck or "FFmpeg missing" | A red banner at the top names the problem and has an **Open log** button. The log (`%APPDATA%\Artifact to Video\logs\main.log`) records each render step |
| Desktop: Windows SmartScreen warning when installing | The installer isn't code-signed yet. Click **More info → Run anyway** |
