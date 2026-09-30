# Worked example: Zuse × boxd launch film

48s (44s without the optional fork beat), 1920×1080 master + 1440×1440 cut, 60fps, music + text,
120 BPM, 96 beats. Built by four parallel builders from the build spec below.

## Beat map

| Beats | Time | Frame | What happens |
| --- | --- | --- | --- |
| 1–8 | 0–4 | f01 open | "zuse." accordion-squeezes into its period → dot → notched square (boxd mark) → lock-up `[icon] zuse × [mark] boxd` |
| 9–16 | 4–8 | f02 machine | mark floods → contracts onto the Blender front view → glass machine, cores light per beat · "Cloud machines for your agents." |
| 17–32 | 8–16 | f03 build image | notched square → Zuse window; Settings → Cloud → Machine provider = boxd → Build image → building → Cloud image ready → Back to app |
| 33–44 | 16–22 | f04 pick boxd | **drop** on the camera punch; Run on → Cloud · boxd → Machine size; Blender size machines explainer |
| 45–56 | 22–28 | f05 send | task types + sends; agent pills; boxd status shape: Starting → Agents running → Preview live |
| 57–64 | 28–32 | f06 URLs | Browser pane pushes in, camera punches onto `https://p3000-m7f3a.boxd.zuse.sh`; port pills; contract to one shape |
| 65–76 | 32–38 | f07 hibernate | **breakdown**; shape → Blender front view → glass frosts · "Step away." + real "Cloud workspace paused" tray |
| 77–80 | 38–40 | f08 wake | **beat return**; "Resuming cloud workspace" → glass clears · "Back in 1–2 seconds." |
| 81–88 | 40–44 | f09 fork (optional) | machine splits into an identical copy · "Fork it." — starts and ends on the same seam state |
| 89–96 | 44–48 | f10 close | machine flies into the ×, CTA pill "Run on → Cloud · boxd" · zuse.sh, collapses back to "zuse." (loop) |

Builder split: A = f01, f02, f10 (brand + loop) · B = f03, f04 · C = f05, f06 · D = f07, f08, f09.

## Build spec (as handed to the builders)

## Zuse × boxd launch film — build spec (frame builders read this)

Project root: `/home/swaraj/.zuse/zuse-e71d257b/audino/launch-video/zuse-boxd` (call it `$P`).
Read first, in this order: `$P/BRIEF.md` (why), `$P/frame.md` (look), this file (how), and the
HyperFrames contract: `~/.claude/skills/hyperframes-core/SKILL.md`,
`~/.claude/skills/hyperframes-core/references/sub-compositions.md`,
`~/.claude/skills/hyperframes-core/references/determinism-rules.md`.
Visual reference for every Zuse UI surface: `$P/.media/ui-reference.html` (open via
`http://127.0.0.1:8765/.media/ui-reference.html`; a server on 8765 serves `$P`). Screenshot of it:
`$P/.media/ui-reference.png` if present. Copy its markup patterns — they are pixel-matched to the app.

### 0. Non-negotiables

- **One continuous take.** Nothing fades, blurs or crossfades between scenes. Scenes are made out of
  the previous one: text rises out of a mask line (`ZK.rise`), icons/pills pop from zero on a spring
  (`ZK.pop`), bars draw, pages push, a boxd-ink shape floods the frame (overscaled past the corners,
  ~0.3s, `ZK.flood`) and contracts into the next scene (`ZK.morph`).
- **Banned:** crossfades, blur-ins, brightness "developing", 3D flips, particles, glows, holds > 1s
  (something must move at least every beat = 0.5s), template looks. Opacity may only be used to
  hide an element at the exact instant another identical-looking element takes its place.
- **A cursor drives every UI change** with real clicks (`ZK.cursor`, `ZK.cursorTo`, `ZK.click`).
  Camera zooms Screen-Studio style (`ZK.camera`) so each moment fills the frame; the cursor lives
  inside the zoomed stage so it scales with the camera.
- **Deterministic:** everything is a pure function of timeline time. No `Date.now`, `Math.random`,
  timers, CSS transitions/animations, `repeat:-1`, network. GSAP tweens + `onUpdate` renders only.
- **Pixel-perfect Zuse UI:** use the kit classes (`z-*`) and `ZK.icon()` exactly as in
  `.media/ui-reference.html`. Do not invent UI that the app does not have (no Pause button, no
  progress bar in image build, no logos inside app menus). Film overlays (headlines, step labels,
  boxd shapes, port pills) live on the canvas outside the app window.
- **Two brands:** Zuse = lime `#BCE426` (film) / `#89ca21` (inside app UI, already in kit) and the
  dark app UI. boxd = rose `#E05A6D`, boxd-ink `#0A0C12`, and the **notch** (bottom-left bite) on
  every boxd-owned shape (`ZK.Shape` / `ZK.notchPath`). Zuse UI windows never carry the notch.

### 1. File + runtime contract (every frame)

- You own only your frame files: `$P/compositions/frames/<id>.html` (placeholders exist — replace
  them). Never edit `index.html`, `variants/`, `compositions/kit/*`, or other builders' frames. If
  the kit lacks something, write a local helper inside your frame and mention it in your report.
- Sub-composition shape (see sub-compositions.md): everything inside `<template>`; root
  `<div id="<id>-root" data-composition-id="<id>" data-width="1920" data-height="1080">` styled by
  `#<id>-root { position:absolute; inset:0 }`; one `gsap.timeline({ paused: true })` registered as
  `window.__timelines["<id>"]`. Prefix every id with the frame id (`f03-…`).
- Globals available (loaded by index): `gsap`, `ZK` (`compositions/kit/kit.js`), `ZK_ICONS`,
  `kit.css` classes, fonts `Archivo` (wdth 62–125%), `Geist`, `Geist Mono`, and
  `window.ZK_FORMAT = {W,H,fork}`.
- **Two canvases, one file:** call `const { aspect, W, H } = ZK.aspect(root)` first. `aspect` is
  `"wide"` (1920×1080) or `"square"` (1440×1440). Lay out absolutely from W/H and the constants
  below; branch where the layout differs. Both must look designed, not cropped.
- Asset paths are project-root relative: `assets/blender/land.webm`, `assets/sfx/click.wav`,
  `assets/zuse-app-icon.png`, `assets/logos/claude.svg`, `assets/boxd-mark.svg`.
- Full-bleed ground: add `<div class="zk-canvas"></div>` as the first child of your root.
- Video: `<video id="<id>-m" src="assets/blender/<shot>.webm" data-start="<local s>" data-duration="<s>" muted playsinline>`
  placed inside a **non-timed** wrapper div that you position/scale. Never put `data-start` on the
  wrapper too. The webm is transparent (VP9 alpha, 810×810 at 30fps; fork is 1620×810). Give the
  wrapper `-webkit-mask-image: radial-gradient(closest-side, #000 72%, transparent 100%)` so the soft
  shadow never shows a rectangle edge (fork: an ellipse over the 2:1 box).
- SFX: `<audio id="<id>-sfx-N" src="assets/sfx/<name>.wav" data-start="<event − peak>" data-duration="<dur>" data-volume="0.55">`
  inside your template. Every `<audio>` needs a unique id. Place by the measured **peak**:

  | name | dur s | peak s | use |
  |---|---|---|---|
  | click | 0.20 | 0.001 | cursor clicks |
  | click2 | 0.35 | 0.193 | heavier click (send, select) |
  | pop | 0.30 | 0.198 | pill / icon pops |
  | pop2 | 0.38 | 0.239 | secondary pop |
  | whoosh | 0.48 | 0.094 | morph / push |
  | swoosh | 1.10 | 0.296 | flood / big morph |
  | air | 1.33 | 1.065 | soft swell (hibernate) |
  | typing | 1.60 | 0.622 | typing bursts (trim with data-duration) |
  | chime | 1.11 | 0.013 | success ✓ / preview live |

  Keep it tasteful: one sound per real event, volumes 0.35–0.7; the music bed is already in index.

### 2. Time + music

120 BPM, 1 beat = 0.5s. Frame durations and global starts (with fork):

| frame | id | global start | dur | beats |
|---|---|---|---|---|
| 01 | f01-open | 0 | 4 | 1–8 |
| 02 | f02-machine | 4 | 4 | 9–16 |
| 03 | f03-build-image | 8 | 8 | 17–32 |
| 04 | f04-pick-boxd | 16 | 6 | 33–44 — **DROP at local 0.0** |
| 05 | f05-send | 22 | 6 | 45–56 |
| 06 | f06-url | 28 | 4 | 57–64 |
| 07 | f07-hibernate | 32 | 6 | 65–76 — **breakdown (quiet)** |
| 08 | f08-wake | 38 | 2 | 77–80 — **beat returns at local 0.0** |
| 09 | f09-fork | 40 | 4 | 81–88 — optional, removable |
| 10 | f10-close | 44 (40 without fork) | 4 | 89–96 |

Land key events on beats (local times that are multiples of 0.5). Frames are seamless: the first
rendered frame of each must equal the last of the previous (see §4).

### 3. Geometry constants (canvas px)

- **Blender machine video** is 810×810, displayed at 1:1. Its opening frame (`*-first.png`) shows the
  cube straight-on as a flat boxd-ink notched square at **(230, 229) size 350×352 inside the video**,
  corner radius **r = 26**, notch **n = 66**. A 2D `ZK.Shape` with those numbers at the same canvas
  position is visually identical → the 2D→3D handoff is a shape change, not a cut.
- `M_CENTER` (frame 02) video box: wide `left 555, top 65`; square `left 315, top 165`.
  → front square on canvas: wide `(785, 294, 350, 352)`, square `(545, 394, 350, 352)`.
- `M_LEFT` (frames 07–10) video box: wide `left 155, top 135`; square `left 315, top 95`.
  → front square on canvas: wide `(385, 364, 350, 352)`, square `(545, 324, 350, 352)`.
  Text column for 07–09: wide `x 1000–1800`, headline 96px Geist 600 baseline ≈ y 470, sub 34px
  below; square: centered text block under the machine, top ≈ y 960.
- **App window** (frames 03–06): native size **1280×800**, `z-window`, placed at camera scale 1 at
  wide `left 320, top 140`; square `left 80, top 320`. Put it inside a full-canvas stage div
  (`transform-origin: 0 0`) and move the camera with `ZK.camera` / `ZK.cameraSet` (stage coords =
  canvas coords at scale 1).
- **Main shell layout inside the window** (frames 03 end → 06): window bg `--z-sidebar`; left pane
  232px wide (sidebar), 4px gutters, main pane x 240–1276, 36px top bars; chat landing h1 "What
  should we build in zuse?" centered in the main pane at window y 300; composer (768 wide, kit
  `z-composer`) at window **x 374, y 352**; composer block ≈ 160px tall → centre (758, 432) in window
  coords = stage **wide (1078, 572)**, **square (838, 752)**.
- Step labels ("1  Build your image" etc., `.zk-step`) sit on the canvas, never inside the window:
  wide `left 72, top 64`; square `left 64, top 72`. They rise from a mask line and sink when done.

### 4. Seams (exact handoff states at frame boundaries)

Each state below must be **exactly** the last frame of the outgoing frame and the first frame of the
incoming one. Numbers are canvas px (wide / square).

- **S1 01→02 (4.0s)** — builder A internal: the lock-up `[Zuse icon] zuse × [boxd mark] boxd`, centred.
- **S2 02→03 (8.0s):** canvas empty except one boxd-ink `ZK.Shape` 120×120, r 12, n 22, centred:
  wide `(900, 480)`, square `(660, 660)`. Camera identity.
- **S3 03→04 (16.0s):** app window at its base position, camera identity (scale 1), showing the
  **main shell**: sidebar (project "zuse", a few chats), chat landing h1, composer with toolbar
  pills `zuse` · `This computer` (ComputerIcon) · `Import chat`, placeholder text, actions row
  (attach, Supervised, goal, plan) and model pill `Opus 5.5 High` + send. No step label visible.
  No cursor visible (it may be parked off the window edge at canvas `(W+40, H/2)`).
- **S4 04→05 (22.0s):** camera centred on the composer centre (§3) at **scale 1.9 (wide) / 1.6
  (square)**; Run on pill now reads `Cloud · boxd` with the DitherCloud icon; menu closed; editor
  shows the placeholder; step label "2  Pick Cloud · boxd" has sunk (none visible). Cursor at the
  composer's editor text start (stage coords: window x 390, y 400 → wide stage (710, 540), square
  (470, 720)), visible.
- **S5 05→06 (28.0s)** — builder C internal.
- **S6 06→07 (32.0s):** canvas only — app window gone. One boxd-ink `ZK.Shape` r 24, n 48:
  wide `(660, 390, 600, 300)`, square `(420, 570, 600, 300)`. Camera identity. No text.
- **S7 07→08 (38.0s)** — builder D internal (hibernate end: frosted machine, tray pill, headline).
- **S8 08→09, 08→10, 09→10 (40.0s / 44.0s):** machine video box at `M_LEFT` showing the wake
  sequence's last frame (`assets/blender/wake-last.png` as the still stand-in in the next frame);
  nothing else on canvas (all text sunk). Frame 09 starts and ends in exactly this state, so it
  can be removed.
- **S9 10→01 (loop):** frame 10's last frame == frame 01's first frame: the wordmark `zuse.`
  (Archivo 800, wdth 125) centred on the canvas, the period a boxd-ink rounded square dot.
  Builder A owns both ends and must make them identical.

### 5. Shot sequences (local times)

#### Builder A — f01-open, f02-machine, f10-close
**f01 (4s).** 0.0 `zuse.` at rest (wordmark ≈ 230px tall wide / 190px square). 0.5 accordion
squeeze: every letter moves toward the period by the same factor while its drawn width follows
(`font-stretch` 125%→62% plus scaleX), letters stay touching and disappear into the dot (swoosh).
1.0 the dot grows into a boxd-ink rounded square 300×300 (spring). 1.5 "meets" (Geist 500, 44px,
`--canvas` colour) rises inside it. 2.0 "meets" sinks; the notch bites in (n 0→56) and the square
springs down to the lock-up's boxd-mark size and position; "boxd" (`.zk-boxdmark`) springs out of it
to the right (pop). 2.5 the Zuse app icon (`assets/zuse-app-icon.png`) pops on the left and "zuse"
(`.zk-wordmark`) rises beside it. 3.0 "×" (Geist 300, `--text-muted`) pops between. 3.5 lock-in
punch (scale 1.02→1, click2). Lock-up ≈ 1500px wide on wide, ≈ 1200px on square, vertically centred.
**f02 (4s).** 0.0 the boxd mark (lock-up's notched square) floods the frame boxd-ink (ZK.flood, the
rest of the lock-up is covered). 0.35 the flood contracts (ZK.morph) to exactly the front-square
rect of `M_CENTER` (r 26, n 66). 0.5 the video `assets/blender/land.webm` starts (data-start 0.5,
duration 3.5) in the `M_CENTER` box; hide the 2D shape at that exact instant (its first frame is
identical). The land video: 0.6s turn from front to 3/4 while the ink turns to glass, then one
process group lights per beat (local 1.5, 2.0, 2.5, 3.0, 3.5 — add a soft pop at each, vol 0.3).
1.5 headline "Cloud machines for your agents." rises under the machine (wide centred at y≈930,
64px; square y≈1080, 60px). 3.5 headline sinks. 3.6–4.0 the machine springs down (scale on the
wrapper) toward the canvas centre and is replaced at scale ≈ 0.15 by the S2 boxd-ink square
(pop-in on the same centre while the machine pops out — a shape swap at tiny size). End on **S2**.
**f10 (4s).** Starts from **S8** (use `assets/blender/wake-last.png` in an `<img>` at `M_LEFT`,
masked like the video). 0.0 the machine springs down and flies into the "×" position of a lock-up
that builds around it: Zuse icon + "zuse" rise on the left, boxd mark + "boxd" on the right; the
machine becomes the "×" (shrink to ~0 as the "×" pops). 1.0 CTA row rises under the lock-up: a
boxd-ink notched pill `Run on → ● Cloud · boxd` (rose dot, on-ink text; "Run on" muted) and
`zuse.sh` (Geist Mono, muted). 2.5 CTA sinks; 2.8 lock-up collapses: "boxd"/icon/× retract into
the boxd mark, "zuse" slides right against it, the mark shrinks and loses its notch into the round-
ish period dot → 3.6 exactly the `zuse.` state of f01 at 0.0 (S9). Hold ≤ 0.4s.

#### Builder B — f03-build-image, f04-pick-boxd
**f03 (8s)** from **S2**. 0.0–0.6 the notched square morphs into the app window (it loses the
notch as it becomes the Zuse window — a boxd shape becoming Zuse UI): grow to the window rect at
base position, radius 12, fill `--z-sidebar`; Settings content "unrolls like a blind" top→bottom
(clip-path inset on the content, whoosh). Show the **Settings** page exactly as the reference:
header "Back to app", rail with "Cloud workspaces · Public beta" active, section title/sub, "Cloud
image" group with Machine provider select currently **Boat**, and the needs-build row ("Cloud image
required", lime "Build image" button). 0.8 step label "1  Build your image" rises (canvas). Cursor
enters from bottom-right. 1.5 camera zooms (≈2.2×) onto the Machine provider select; 2.0 click →
native menu opens (Boat, E2B, boxd); 2.5 hover boxd; 3.0 click boxd → select reads `boxd`
(menu closes). 3.5 camera eases to the Build image button; 4.0 click Build image → row becomes the
building strip (spinner rotating, "Building cloud image", "Preparing repositories and agents", "In
progress" badge) — spinner rotation is a timeline tween; 4.5–6.0 phase text steps through
"Preparing repositories and agents" → "Installing agents" → "Snapshotting boxd machine" on beats.
6.5 row becomes ready: "Cloud image ready", "Repositories ready for new Cloud chats: 3.", green
"Ready" badge pops (chime). 7.0 step label sinks; camera eases back to scale 1; 7.3 click "Back to
app" → 7.4–7.9 the main shell pushes in from the right over the settings page (page push, whoosh).
End on **S3** at 8.0.
**f04 (6s)** from **S3**. 0.0 (the DROP) camera punches in to the composer toolbar (≈2.4× on the
Run on pill) in ~0.3s (snap ease) — land the zoom exactly on the drop. 0.3 step label "2  Pick
Cloud · boxd" rises. 0.8 cursor clicks the Run on pill → the "Run on" glass menu pops open upward
(scale from 0.96 + y offset, spring — no fade) with rows exactly as the reference: This computer
(selected), separator, Cloud · Boat / Cloud · E2B / Cloud · boxd each with "Beta". 1.5 hover
Cloud · boxd; 2.0 click → selection indicator moves to boxd, the pill label changes to "Cloud ·
boxd" with the DitherCloud icon, and the "Machine size" section springs open below (Standard (2
vCPU / 8 GB) selected, Small (1 vCPU / 4 GB), Large (4 vCPU / 16 GB)). 2.5–3.5 **size explainer on
the canvas beside the zoom**: three small Blender machines (`blender/renders/sizes/size-small.png`,
`size-standard.png`, `size-large.png` — copy them to `assets/blender/` if missing) pop in order with
their labels; the Standard one is ringed. 3.5 cursor clicks Standard. 4.0 menu closes (retracts on
a spring), the machines sink. 4.5 step label sinks. 4.5–6.0 camera eases to **S4** (centre on the
composer, scale 1.9 / 1.6), cursor glides to the editor. End on **S4**.

#### Builder C — f05-send, f06-url
**f05 (6s)** from **S4**. 0.0 step label "3  Send the task" rises. 0.2–1.4 the task types into the
editor: "Fix the flaky auth test and open a PR" (ZK.type, typing sfx). 1.5 click the send button
(click2). 1.7 camera pulls back to scale ~1; the sent message appears in the main pane thread (user
bubble, right aligned, app styling) and the composer clears. 2.0 two agent pills pop on the canvas
beside the window (boxd-free: Zuse-style dark pills with provider logos): Claude Code, Codex, each
with a lime dot. 2.5 a boxd-ink notched status shape grows out of the Run on pill position and
morphs through three states on beats: "Starting boxd machine" (rose dot) → 3.5 "Agents running"
(expands into a terminal card: Geist Mono lines `$ git worktree add ../fix-auth-test`, `$ bun test
auth/recovery.spec.ts`, `✓ 14 passed`, `opening PR…` typed line by line) → 5.0 a "Preview live"
pill (rose dot) buds off the card's bottom edge (pop). Cursor ends over "Preview live". The window
may slide/scale left to make room (camera or stage move), but everything stays one take.
**f06 (4s)**. 0.0 click "Preview live" → the app's right pane pushes in inside the window with the
**Browser** tab active; the URL types into the `z-url` field: `https://p3000-m7f3a.boxd.zuse.sh`; the
stand-in page (reference markup) wipes in top→bottom. 0.8 headline "Every port gets a URL." rises on
the canvas. 1.5 and 2.0 two more port pills pop out of the window's right edge onto the canvas,
stacked under the first: boxd-ink notched pills with rose dot, Geist Mono: `:3000 → p3000-m7f3a.boxd.zuse.sh`,
`:5173 → p5173-m7f3a.boxd.zuse.sh`, `:8080 → p8080-m7f3a.boxd.zuse.sh` (the first one comes from the
Preview live pill). 3.0 headline sinks; 3.1–4.0 everything contracts: window and pills collapse into
one boxd-ink notched shape (flood-in reverse: the window's dark body becomes boxd-ink as it
shrinks) that lands exactly on **S6**.

#### Builder D — f07-hibernate, f08-wake, f09-fork
**f07 (6s)** from **S6**, music breakdown (quiet — keep SFX soft). 0.0–0.6 the S6 shape morphs to
the front-square rect of `M_LEFT` (r 26, n 66). 0.6 `assets/blender/hibernate.webm` starts
(data-start 0.6, duration 5.0) in the `M_LEFT` box; hide the 2D shape at that instant. (The clip:
0.6s turn to 3/4 with processes live, then from ~1.2s the glass frosts and processes freeze one by
one.) 1.2 headline "Step away." rises in the text column; 1.7 sub "It hibernates — memory,
processes and agents, all kept." rises; 2.5 the real app tray pill pops in under the sub (kit
`z-tray` on a `--z-composer-toolbar` rounded-top strip, exactly as the reference): DitherCloud ·
"Cloud workspace paused" · "Sending a message or opening a live tool will resume it." (pop2, soft).
Keep something moving every beat (frost progress is the motion; add a subtle 1–2px drift if needed).
End state (38.0): frosted machine (video last frame), headline, sub, tray pill visible.
**f08 (2s)**, beat returns at 0.0. 0.0 `assets/blender/wake.webm` starts in `M_LEFT` (data-start 0,
duration 2) — the glass snaps clear by 0.3 and processes relight. 0.0 the tray pill switches to the
resuming state (LoaderCircle spinning · "Resuming cloud workspace" · "The sandbox compute is waking
up."), 0.5 it collapses (spring) and the headline/sub sink; 0.6 "Back in 1–2 seconds." rises
(headline) and a small Geist Mono terminal strip on ink `z-window` styling continues mid-line:
`✓ 14 passed · opening PR█` → `PR #482 opened` typed at 1.0. 1.5–2.0 all text sinks → **S8**.
**f09 (4s)**, optional — starts and ends on **S8**. Video `assets/blender/fork.webm` (1620×810) in a
box whose centre 810 square aligns with `M_LEFT` (wide `left −250, top 135`; square `left −90, top
95`), ellipse-masked. The clip: the copy springs out to the right at 0.5, camera pans to it
1.6–3.2, the original drifts off-frame left. 1.0 "Fork it." rises (text column, above the video);
1.5 sub "A new machine, same state, in seconds."; 2.0 a boxd-ink notched pill pops: rose dot ·
"New machine · ready". 3.2–3.6 all text sinks; end exactly on **S8** (the video's last frame centre
square == wake's last frame; switch to `wake-last.png` at 4.0 only if the next frame needs it —
frame 10 already starts from `wake-last.png`).
Use "Fork" wording only on the canvas overlay (the app's fork UI is for messages; the machine fork
is a new boxd feature).

### 6. Validate before you report

From your private preview projects (never the shared `snapshots/`):
`cd $P/.work/<A|B|C|D>-wide && npx hyperframes snapshot --at <times> --no-end` and the same in
`$P/.work/<X>-square`. Check: the seam instants (end − 0.02 and start + 0.02), every beat event,
mid-frame layout, and both aspects. Also run `cd $P && npx hyperframes lint` (0 errors for your
files). Blender media may still be rendering — if `assets/blender/<shot>.webm` is missing, build
against `<shot>-first.png`/`-last.png` if present, or leave the video element wired to its final
path; it will appear when encoded.

Report back: files written, the exact seam states you produced (numbers), anything you could not
match, and snapshot paths proving both aspects.
