# Production

## Project layout

Keep video projects out of the product source (e.g. an untracked top-level `launch-video/<name>/`);
do not commit them unless asked.

```
<project>/
  BRIEF.md  STORYBOARD.md  BUILD-SPEC.md  frame.md  storyboard.html
  index.html                     # master (generated)
  variants/<name>/index.html     # other cuts (generated; compositions/ + assets/ symlinked back)
  compositions/kit/              # kit.js, kit.css, icons.js
  compositions/frames/fNN-*.html # one sub-composition per beat group
  assets/{fonts,sfx,music,blender,logos,vendor}/
  blender/{anim.py,render-all.sh,encode.sh,renders/}
  scripts/build-index.mjs
  .media/                        # ui-reference.html, candidates (ignored by lint)
  .work/<builder>-<aspect>/      # private preview projects for parallel builders
  renders/  renders/final/
```

Start with `npx hyperframes init <dir> --non-interactive --example=blank --skill=product-launch-video`,
then copy the templates in. Vendor GSAP into `assets/vendor/` (`curl` the exact version once): a CDN
hiccup blocked a render mid-delivery (`sub_timeline_script_failure`).

## Variants (aspect ratios × removable beats)

- HyperFrames allows **one root composition per project**. `build-index.mjs` writes the master to
  `index.html` and each other cut to `variants/<name>/index.html` with `compositions/` and `assets/`
  symlinked, so every cut renders from the same frame files.
- It sets `window.ZK_FORMAT = {W, H, fork}` before frames load; frames call `ZK.aspect(root)` first
  and branch layout on `"wide"` vs `"square"`.
- The runtime copies a frame root's authored `data-width/height` (1920×1080) onto its host slot, so a
  square cut came out 1920×1080 tall. `ZK.aspect` now resizes the root and its host to the real canvas.

## Parallel builders

- Write `BUILD-SPEC.md` first (see `example-zuse-boxd.md`): non-negotiables, file contract, time
  table, geometry constants, numbered seam states, per-frame shot sequences with local times, SFX
  table with peaks, validation steps.
- Split frames into 3–4 continuous runs (brand/loop · UI step A · UI step B · 3D payoff). Each builder
  owns only its frame files and never edits the kit — they report kit gaps; you fix the kit centrally
  and message every builder (we did this for square sizing and a click-ring bug).
- `hyperframes snapshot` wipes `./snapshots/` and has no output flag. Give every builder its own
  preview projects (`.work/<X>-wide`, `.work/<X>-square`: a copied `index.html` + symlinks) so
  parallel snapshotting never collides.
- Review their snapshots yourself (contact sheets via `ffmpeg … tile=`), and send precise fixes by
  message (e.g. "the h1 renders above the Run on menu at 19.2s"; "punch the camera onto the URL bar").

## Validation

- `npx hyperframes lint` → 0 errors. Remaining warnings are expected (nested media start basis,
  large composition files).
- `npx hyperframes check` layout "errors" include false positives from hidden-but-mounted frames and
  text sampled mid-animation. Confirm by snapshotting the flagged times before acting on them.
- Snapshot every seam (`end − 0.02` / `start + 0.02`) in every aspect.
- Render the master and run `pop-scan.sh`; look at a 2-second contact sheet of the real MP4.

## Rendering

`npx hyperframes render --skill=product-launch-video -q high -f 60 -o renders/<cut>.mp4` from the
project root (master) or from `variants/<name>/` (other cuts). ~1 minute per 48s cut on a 24-core
machine with `beginframe` capture. Then `loudnorm.sh` each into `renders/final/`.

## Gotchas index

| Symptom | Cause / fix |
| --- | --- |
| Click ring visible before the click | `fromTo` renders its start state immediately → `immediateRender: false` (fixed in kit). |
| Square cut uncovered below y=1080 | host copies authored size → `ZK.aspect` resizes root + host. |
| Half the screen changes in one frame at a flood | ease per coverage: grow `power1.out`, shrink `power1.in`. |
| Text shows through a menu | glass is translucent and the film cannot blur → solid base + z-index. |
| Grey floor / frosted glass in 3D | EEVEE → use Cycles with a shadow catcher. |
| Brightness jump at 2D→3D handoff | face renders charcoal, not ink → tint the shape in its last 0.1s. |
| Render blocked: script failed to load | CDN GSAP → vendor it locally. |
| Parallel builders deleting each other's snapshots | private `.work/` preview projects. |
| Lint: multiple root compositions | variants live in `variants/<name>/`, not as extra root HTML files. |
| Lint: parent traversal in asset path | `@font-face` in the index (root-relative), not in `kit.css`. |
| Renders/assets vanished | `/tmp` is wiped on reboot — keep everything in the project. |
