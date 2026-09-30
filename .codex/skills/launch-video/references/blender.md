# Blender

Blender renders the film's single 3D hero object (for boxd: a glass machine with lit "process"
cubes inside). Everything else is 2D. The object sits on the same off-white canvas via a transparent
render with a real contact shadow, so 2D and 3D read as one world.

## Setup

- Install without sudo: download `blender-<ver>-linux-x64.tar.xz` from `download.blender.org`, extract
  to `~/.local/opt`, symlink `~/.local/bin/blender`. Scripts run headless: `blender -b -P script.py -- args`.
- **Use Cycles (CPU), not EEVEE.** EEVEE has no shadow catcher (the floor renders grey) and its glass
  reads frosted. Cycles at 810px, 28 samples + OpenImageDenoise ≈ 7s/frame on a 24-core CPU; double
  that for a 2:1 frame with two objects. Budget ~1h for ~450 frames and start renders first.
- Render 30fps PNG sequences with `film_transparent = True` and a plane with `is_shadow_catcher = True`.
  View transform AgX, look "Medium High Contrast".

## The look (see `templates/blender/anim.py`)

- Product-shot lighting: one large soft key area light high-left, a weaker fill right; world colour =
  the canvas colour so reflections belong to the stage.
- Materials: clear glass (transmission 1, roughness 0.02, IOR 1.45); "hibernated" = the same glass at
  roughness ~0.42 (frosted) with the lit cores desaturated to grey; lit cores = base colour + low
  emission (0.35) so they read as *lit surfaces*, not glowing halos. Keep emission low — bright
  emission under AgX washes lime to pale yellow.
- Brand motif in 3D: the partner's logo notch is a boolean bite out of the cube's bottom-front-left
  edge, so the straight-on view *is* their logo.
- Deterministic "life": per-core emission breathing on fixed phases (no randomness), keyframed.

## The 2D → 3D handoff (the key trick)

Every 3D sequence that follows a 2D shape **opens straight-on** (camera azimuth −90°, elevation 0,
long lens) on the object with an opaque dark material, so its first frame is a flat dark rounded
square. Then over ~0.6s the camera swings to the hero 3/4 view while the material mixes to glass.

1. Render the first frame, measure the opaque bbox with PIL (alpha ≥ 250) — boxd machine at 810px:
   `(230, 229)`, 350×352, radius ≈ 26, notch ≈ 66.
2. In HyperFrames, morph the 2D shape onto exactly that rect (video box position + bbox offset).
3. In the last ~0.1s shift the 2D fill to the render's face colour (the "black" face renders charcoal
   ≈ `#3E3F41`), then start the video on that instant and hide the shape.

## Encoding and placement

- `templates/blender/encode.sh <shot>` → transparent **VP9 WebM** (`yuva420p`, `-auto-alt-ref 0`) plus
  `<shot>-first.png` / `<shot>-last.png`. HyperFrames preserves VP9 alpha in both snapshots and final
  renders (verified).
- Place the `<video>` in a non-timed wrapper with a radial `mask-image` (closest-side, #000 72% →
  transparent) so the soft shadow never shows a rectangular edge.
- Use `<shot>-last.png` as a still stand-in wherever the next frame starts from the object.

## Pitfalls we hit

- Multi-object moves (the fork): the copy started inside the original (the first 21 frames were one
  black cube), came toward the camera and clipped at the frame edge, and the original never fully
  left. Plan multi-object shots with the object moving along the camera's right vector, keep the
  copy slightly offset before the split, and push the leaver fully out. Or fake it in 2D from stills
  (what we shipped for the optional fork beat).
- Keep all size variants on the same camera so relative scale is true (Small / Standard / Large).
- `/tmp` is wiped on reboot — keep renders inside the project (`blender/renders/`).
