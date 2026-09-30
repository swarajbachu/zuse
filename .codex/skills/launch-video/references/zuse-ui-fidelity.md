# Zuse UI fidelity

"Pixel-perfect" means the recreated screens use the app's real tokens, icons, sizes and strings —
and show only what the app really has.

## Extract, don't guess

1. **Specs:** dispatch an Explore sub-agent over `apps/renderer/src` (and `packages/ui`) for the
   surfaces the film needs. Ask for DOM structure, Tailwind resolved to CSS values, icon names,
   i18n strings resolved from `packages/i18n/locales/en/**`, and the dark-theme tokens. Also ask what
   does *not* exist (in the boxd pass: no Pause button, no image-build progress bar, fork exists only
   on messages, Worktree/Local is not in the Run on menu).
2. **Tokens:** dark theme from `apps/renderer/src/styles.css` + `packages/ui/src/app-palette.css`
   (e.g. `--background #0b0c0b`, `--foreground #e8e9e7`, `--popover #191c1a`, `--muted #222523`,
   `--accent #282d28`, `--primary #89ca21`, radius md 7px / lg 10px / xl 12px). The kit's `z-*`
   classes already encode the composer, Run on menu, settings rail/groups, badges, tray and Browser
   URL bar — extend them rather than restyling per frame.
3. **Icons:** `bun templates/kit/extract-icons.mjs > compositions/kit/icons.js` (Hugeicons from
   `@hugeicons/core-free-icons` at stroke 1 as the app forces it, the pixel-art `DitherCloud`, and the
   lucide icons the app uses). Render with `ZK.icon(name, size)`.
4. **Strings:** copy exact text (e.g. composer placeholder "Ask to make changes at the @ mentioned files
   or run slash commands, shift enter for next line.", "Cloud · boxd" + "Beta", "Machine size",
   "Standard (2 vCPU / 8 GB)", "Cloud image ready", "Cloud workspace paused").
5. **Fonts:** Geist / Geist Mono from `node_modules/@fontsource-variable/{geist,geist-mono}`; the
   composer editor uses the system UI stack at 12px, not Geist.
6. **Brand marks:** `apps/web/public/app-icon.png` (Zuse icon), `apps/web/public/logos/*.svg`
   (provider logos, tint with `currentColor`).

## Reference page

Build `.media/ui-reference.html` (template in `templates/kit/`) rendering every surface in its
states, screenshot it, and compare against the spec before any animation. Builders copy markup from
it. Keep it out of `compositions/` — HyperFrames lint treats any HTML there as a composition.

## Rules

- Never invent UI. If the story needs a control the app lacks, tell the story through real UI or
  through a canvas overlay that is clearly film graphics.
- Popups sit above page content (z-index) with a solid base under the glass — the film cannot blur, so
  a translucent glass menu lets text behind it show through.
- Zuse windows never carry partner motifs (the notch); partner shapes are overlays.
- Stale assets lie: `apps/web/public/assets/product/zuse-workspace.png` still shows the old name.
  Build from source, not screenshots.
