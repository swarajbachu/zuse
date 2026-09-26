# Warm Paper

A warm ivory theme with ink text and copper accents. Install, then select it under Extension themes.

Install from Settings → Extensions → Curated marketplace, then choose **Warm Paper** under **Extension themes**. Installing does not automatically change your appearance. Disable/remove the extension to fall back to the built-in theme. No files, network services, or agent prompts are used.

This independent client-only extension declares the `themes` capability and registers one light palette through `addTheme`. Palette fixtures are in `fixtures/palette.json`; tests verify body/accent text contrast. Dependencies are locked by the repository's `bun.lock`. From the repository root, run `bun install --frozen-lockfile`, then `bun run --cwd extensions/warm-paper test` and `bun run --cwd extensions/warm-paper check-types`.
