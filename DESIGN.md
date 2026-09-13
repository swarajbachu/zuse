# Zuse Desktop Design System

Zuse is a calm, dense desktop workspace with a restrained neutral palette,
clear typography hierarchy, compact geometry, and subtle surface treatment.
Lime remains the product signature.

## Principles

- Keep the workspace primary. Navigation and secondary context stay quiet.
- Use one accent. Lime is for primary actions, active agents, progress, and
  focus, not general selection or decoration.
- Prefer spacing and tonal surfaces to visible container borders.
- Cards exist only when they group a real interaction or distinct state.
- Preserve information density. Compact settings and authentication controls
  are 28px high (`h-7`) with coarse-pointer hit expansion.

## Foundations

- Typeface: Geist Sans Variable for interface text, Geist Mono Variable for
  code, commands, identifiers, and tabular technical data.
- Type: 14px interface body, 12px compact labels, 11px supporting copy, and
  24/32px medium-weight page titles where a spacious page calls for one.
- Spacing: 4px base grid. Common gaps are 4, 8, 12, 16, 24, and 32px.
- Radius: 7px default, 10px cards, 12px dialogs, 999px status pills.
- Motion: 140ms exits and 180ms entrances. Animate opacity and transform;
  respect `prefers-reduced-motion`.

## Color Roles

Light mode uses a quiet green-tinted neutral ladder with
`hsl(90 20% 97%)` canvas, white cards, and `hsl(132 14% 13%)` primary text.
Dark mode uses an almost-neutral green-black surface hierarchy:
`hsl(140 5% 4.5%)` canvas,
`hsl(136 5% 7.5%)` cards, and `hsl(132 5% 10.5%)` elevated surfaces. The hue
should register as black first and green only on closer inspection. Text is a
softened off-white rather than pure white.

Semantic colors use green, red, orange, and blue roles. The primary lime is
deep and controlled, not neon; ordinary hover and selected surfaces use the
green-black neutral ladder instead of lime fills. All shared colors are
stored as complete `hsl(...)` values so Tailwind opacity modifiers such as
`bg-card/10` and `border-border/60` compose correctly. The chartreuse lime is
the only brand accent.

## Components and Layout

- Buttons, fields, selects, and switches use shared primitives. Avoid local
  copies unless a native control is required for platform behavior.
- Selected navigation uses a neutral background. Status and primary actions
  may use lime.
- Settings use one section/row pattern: title and description on the left,
  compact action on the right, and hairline separators between rows.
- Dialogs have a clear header, scrollable body, and tonal footer separated by
  one hairline. Backdrops may use a small blur; ordinary surfaces may not.
- Empty states explain what is absent and offer a specific next action when
  one exists. Errors explain what happened and how to recover.

## Accessibility and Responsive Behavior

- Meet WCAG AA contrast, retain visible `focus-visible` treatment, and never
  encode state with color alone.
- At the 720x480 minimum window, preserve the primary task, reduce page
  gutters, and collapse secondary navigation/context before the workspace.
- Visible desktop controls remain compact. Pointer-coarse hit regions expand
  to at least 44px without changing visible layout.
