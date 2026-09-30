# Design direction

## The idea in one line

An Apple-keynote product segment, shot as **one continuous take** on a warm off-white stage: the dark
Zuse UI and one morphing black shape carry the story, a single Blender-rendered object is the hero,
and a cursor drives every change with real clicks.

## Palette

| Role | Value | Rule |
| --- | --- | --- |
| Canvas | `#F4F1EB` warm off-white | Ground of every frame. Mostly empty — silence is the premium signal. |
| Ink (film) | `#0E0F11` | Headlines, wordmark, step-number discs. |
| Zuse lime (film) | `#BCE426` | Zuse's voltage. **Only on dark surfaces** (dots, ✓, step numbers) — never as text on the canvas. |
| Zuse lime (in-app) | `#89ca21` | Inside recreated app UI only (that is the app's `--primary`). |
| App UI | tokens from `apps/renderer/src/styles.css` dark theme | See `zuse-ui-fidelity.md`. |
| Muted text | `#6B6B6B` | Sub-lines, "×", secondary labels on canvas. |

**Partner brands mix in, they do not replace Zuse.** For boxd we took `#0A0C12` (boxd ink) for every
shape that belongs to them, `#E05A6D` (rose) as their accent, and their logo's corner **notch** as a
motif. Rule of thumb: Zuse = lime + the app UI; partner = their accent + their ink + their shape
motif. Lime and the partner accent never share one element; when both appear, lime is the actor
(agents), the partner accent is the stage (machine/infra). Pull partner tokens from their site
(`curl` the page, count hex colours, read the logo SVG path) — do not guess.

## Type

- **Wordmark:** Archivo 800, `font-stretch: 125%`, tracking −0.035em. Variable Archivo (wght + wdth)
  from `@fontsource-variable/archivo` so the accordion squeeze can animate the width axis.
- **Everything else:** Geist (the app's `--font-sans`), headlines 600 at −0.035em, subs 400 muted.
- **Machine text:** Geist Mono — terminals, URLs, sizes.
- Partner wordmark in their own feel (boxd: medium grotesk → Geist 500, −0.02em) next to their mark.

## Composition

- The lock-up: `[Zuse app icon] zuse × [partner mark] partner` — `assets/zuse-app-icon.png` is the
  real desktop icon (black squircle, white Z bolt). The "×" is a light, muted glyph, not a box.
- Step labels ("1  Build your image") sit on the canvas in the margin, never inside the window.
- Film overlays (headlines, pills, status shapes, explainers) live on the canvas outside the app
  window. The app window only ever shows things the app really shows.
- The 1:1 cut is **re-laid out**, not cropped: side-by-side becomes stacked, the camera targets the
  same controls.

## Copy

- Short, declarative, product-true: "Cloud machines for your agents." · "Step away." · "Every port
  gets a URL." · "Back in 1–2 seconds." One idea per line; no exclamation marks.
- Use the app's real strings for anything inside the UI (Run on, Cloud · boxd, Cloud image ready…).
- **Claims are the user's call.** Speeds, availability ("now in Zuse"), URLs, and labels for features
  still being built must be confirmed before render. Record defaults and pending confirmations in
  `BRIEF.md`. (We shipped "Back in milliseconds." as a default; the real number was 1–2 seconds.)
- If the app lacks an affordance the story wants (there is no Pause button), tell the true story
  (the workspace hibernates when you step away; sending a message resumes it) using the real UI
  (the "Cloud workspace paused" tray) rather than inventing a control.

## Banned

Crossfades, blur-ins, brightness "developing", 3D flips of UI, particles, glows/halos, holds longer
than 1s, gradient blobs, stock-template looks, website illustrations (unless asked), opacity fades as
transitions. Opacity is allowed only to swap two visually identical elements at the same instant.
