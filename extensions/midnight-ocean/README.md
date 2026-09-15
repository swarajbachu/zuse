# Midnight Ocean

A deep navy theme with sea-glass accents. Install, then select it under Extension themes.

Install from Settings → Extensions → Curated marketplace, then choose **Midnight Ocean** under **Extension themes**. Installing does not automatically change your appearance. Disable/remove the extension to fall back to the built-in theme. No files, network services, or agent prompts are used.

This independent client-only extension declares the `themes` capability and registers one dark palette through `addTheme`. Palette fixtures are in `fixtures/palette.json`; tests verify body/accent text contrast. Dependencies are locked by the repository's `bun.lock`. From the repository root, run `bun install --frozen-lockfile`, then `bun run --cwd extensions/midnight-ocean test` and `bun run --cwd extensions/midnight-ocean check-types`.
