# Motion and transitions

## Doctrine: every scene is made out of the previous one

There are no cuts. A transition is always a **shape change** of something already on screen:

| Move | How | Kit |
| --- | --- | --- |
| Text arrives | rises out of a mask line (overflow-hidden wrapper, inner `yPercent 110 → 0`) | `ZK.rise` / `ZK.sink` |
| Icon / pill arrives | pops from scale 0 on an underdamped spring | `ZK.pop` |
| Bars / progress | draw across (width or scaleX), never fade | — |
| Page change | push (the new page slides in over the old) or "unroll like a blind" (clip-path inset top→bottom) | — |
| Big scene change | a dark shape **floods** the frame (overscaled past the corners) and **contracts** into the next scene's first object | `ZK.flood`, `ZK.morph` |
| Brand shape ↔ UI | the partner's notched shape morphs into the Zuse window, losing its notch as it becomes Zuse UI | `ZK.Shape` + `ZK.morph` |
| 2D → 3D | the 2D shape lands on the exact pixels of the Blender object's first frame, then the video takes over | see `blender.md` |
| Typing | characters by timeline progress | `ZK.type` |

Something must move at least every beat (0.5s at 120 BPM); no hold over 1s. During quiet beats, a slow
push-in (2–4%) or a 1–2px drift keeps the frame alive.

## Springs

All springs are closed-form step responses, so any frame is a pure function of time:
`ZK.spring(t, zeta, w)`; `ZK.springEase(dur, zeta, w)` turns one into a GSAP ease pinned to land on 1.
Presets: `pop` (ζ 0.5, snappy overshoot), `soft` (ζ 0.78, UI moves), `snap` (ζ 0.9, camera punches).
A value with several targets over time is a sum of springs, one per change.

## Flood rules (learned the hard way)

- Overscale past the corners (pad ≥ 25% of the long side) so the edge never sweeps across mid-frame.
- ~0.3s. Ease so **screen coverage changes evenly per frame**: when growing from small, ease-out
  (`power1.out`); when contracting from full-frame, ease-in (`power1.in`). The first version used
  `power2.in` to grow and `power4.out` to contract — ~75% of the screen changed in two frames.
  `pop-scan.sh` catches this.

## Camera (Screen-Studio style)

- Put the app window on a full-canvas stage (`transform-origin: 0 0`); the camera is a transform on
  the stage: `ZK.camera(tl, stage, t, dur, cx, cy, scale, W, H)` frames stage point (cx, cy) at the
  viewport centre.
- App UI is authored at native pixels (12px text); zoom 1.9–2.4× on the active control so it reads.
  Punch in on key moments (the music drop, the URL typing) with `snap`; ease out with `soft`.
- The cursor lives inside the stage so it scales with the camera.
- Canvas overlays that must track a zoom move with the same camera transform; at rest they have no
  transform, so seams stay exact.

## Cursor

`ZK.cursor(parent, x, y)` makes a macOS-style arrow + a click ring. `ZK.cursorTo` glides the tip;
`ZK.click` presses (scale 0.86), releases on a spring, and expands a stroke ring (no glow). Every UI
state change is caused by a visible click. Park the cursor off-window at seams where it should not show.

## Seams between frames (multi-builder films)

- Define each shared seam as an exact **state** in BUILD-SPEC: every element's rect, radius, notch,
  fill, camera (cx, cy, scale), cursor position. The outgoing frame's last rendered frame must equal
  the incoming frame's first.
- Give each builder a *continuous run* of frames so most seams are internal to one person.
- Verify by snapshotting `end − 0.02` and `start + 0.02` and diffing; aim for 0 differing pixels
  (anti-aliasing noise of a few pixels is fine).
- **Removable beats** (an optional feature that may not ship): make the beat start and end in the
  *identical* state as its neighbours' seam, and make it an exact number of bars so the music edit is
  a clean splice. Then removing it from the frame list leaves a valid seam.
- **Loop:** last frame = first frame (`zuse.` wordmark), so feeds loop cleanly.

## Pop scan

After rendering, `templates/scripts/pop-scan.sh film.mp4 25` lists frames whose mean luma change is
large. Expected hits: floods and camera punches. Anything else is a seam bug.
