---
name: launch-video
description: Make Zuse launch, feature and partner-announcement videos in the house style — a continuous-take Apple-keynote film built with HyperFrames, with pixel-faithful Zuse UI, Blender 3D hero objects, beat-mapped music and seamless shape-change transitions. Use when asked for a Zuse promo, launch film, feature explainer, integration/tie-up announcement, or "a video like the boxd one".
---

# Zuse launch videos

The house style was established by the Zuse × boxd launch film (48s, 16:9 + 1:1, with and without an
optional beat). This skill is everything that made it work: the look, the motion doctrine, the music
taste, the Blender pipeline, the UI-fidelity process, and the production mechanics that keep a
multi-builder film seamless.

HyperFrames is the engine. Load `/hyperframes` first (it installs its workflow skills and owns the
composition contract); this skill layers the Zuse house style and the lessons on top. The creative
defaults below are defaults — the brief still comes from the user.

## Read on demand

| File | Read it when |
| --- | --- |
| `references/design-direction.md` | Planning the look, copy, brand mixing (partner colours, notch-style motifs), and what is banned. |
| `references/motion-and-transitions.md` | Writing the beat map, designing seams, camera, cursor, springs; any "how do I get from A to B without a cut". |
| `references/music-and-sound.md` | Choosing and editing the track, placing SFX, setting loudness. |
| `references/blender.md` | Any 3D object: modelling, materials, the 2D→3D handoff, render budget, encoding with alpha. |
| `references/zuse-ui-fidelity.md` | Recreating any Zuse screen — tokens, icons, strings, and what must never be invented. |
| `references/production.md` | Project layout, variants (aspect ratios, removable beats), parallel builders, validation, rendering, gotchas. |
| `references/example-zuse-boxd.md` | A complete worked example: beat map, seams, geometry, builder split. Copy its shape. |

## Templates (copy into the new project, then adapt)

- `templates/kit/kit.js`, `kit.css` — the shared motion kit (closed-form springs, notched shape morphs,
  flood, cursor + clicks, mask-line rise/sink, typing, camera, aspect handling) and pixel-matched
  Zuse UI component classes. Goes in `compositions/kit/`.
- `templates/kit/extract-icons.mjs` — writes `compositions/kit/icons.js` from the app's real icon sources.
- `templates/kit/ui-reference.html` — a static page rendering every UI surface with the kit; goes in
  `.media/` (outside `compositions/`, so HyperFrames lint ignores it). Builders copy markup from it.
- `templates/scripts/build-index.mjs` — generates the master `index.html` plus variant projects
  (aspect ratios × optional beats) from one frame list.
- `templates/blender/anim.py`, `render-all.sh`, `encode.sh` — the machine scene, batch render, and
  PNG-sequence → transparent VP9 WebM encoding.
- `templates/scripts/analyze-music.py`, `splice-music.sh`, `sfx-peaks.py`, `loudnorm.sh`,
  `pop-scan.sh` — tempo/structure analysis, bar-aligned edits, SFX peak placement, −17 LUFS mastering,
  and the single-frame-pop scan for rendered films.

## Workflow

1. **Brief.** Run the `/hyperframes` intent layer (route: `product-launch-video`). Pin: the one-line
   message, audience, deliverables (default 16:9 master + 1:1 cut, 60fps), length (40–50s sweet spot),
   music + on-screen text (no voiceover by default), storyboard review yes. Confirm factual claims
   (availability, speeds, URLs, labels) with the user before they go on screen — see design-direction.
2. **Truth pass.** Before designing, extract the real product surface: labels from
   `packages/i18n/locales/en`, component specs from `apps/renderer/src` (use an Explore sub-agent),
   and for partners their brand from their own site. Never animate a UI the app does not have.
3. **Beat map.** 120 BPM, 1 beat = 0.5s. Map every scene to beats; put the drop on the product
   reveal, the breakdown on the quiet/"step away" moment, the beat return on the payoff. Make the last
   frame equal the first so the film loops.
4. **Storyboard.** `STORYBOARD.md` + a `storyboard.html` sketch sheet (real fonts, real copy, stand-in
   blocks). Get approval. Then write `BUILD-SPEC.md` — exact geometry, seam states, timings, SFX.
5. **Assets.** Blender renders (start early — they are the long pole), music edit, SFX, kit + icons +
   UI reference.
6. **Build.** Split frames across 3–4 parallel builders by *continuous runs* (so each owns its inner
   seams); every shared seam is a numbered state in BUILD-SPEC. Give each builder private preview
   projects. Review their snapshots yourself and send precise fixes.
7. **Verify.** `hyperframes lint` (0 errors), snapshots at every seam in every aspect, render the
   master, run `pop-scan.sh`, look at a contact sheet of the real MP4.
8. **Deliver.** Render every variant, `loudnorm.sh` each to −17 LUFS, hand over paths + durations +
   the list of claims still needing confirmation. Do not commit the video project unless asked.

## Non-negotiables

- One continuous take: scenes are made out of the previous one. No crossfades, blur-ins, glows,
  particles, 3D flips, holds over 1s, or template looks.
- Pixel-faithful Zuse UI with the app's exact strings; film overlays live outside the app window.
- Everything deterministic and seek-safe (pure function of time; no clocks, randomness, CSS transitions).
- Every seam is verified from the rendered frames, in every aspect, not assumed.
