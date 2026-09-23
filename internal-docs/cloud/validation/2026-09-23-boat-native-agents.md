# Boat native-agent template validation — PR #635

Tested on 2026-09-23 with a dedicated base Boat sandbox (`bx_b4k4n75s`).
Built the server and serve tarballs from the PR checkout, uploaded the actual
provisioning payload, and ran `box/install.sh` as root. No production template,
account image, or production configuration was changed.

## Results

- Actual template installation completed, including Node 22, OS dependencies,
  Bun/Corepack, Zuse runtime, and unprivileged user setup.
- Claude 2.1.281, Codex 0.156.1, and OpenCode 1.18.32 ran as `zuse`.
  Their launcher/binary SHA-256 hashes matched the original Boat image before
  provisioning, after provisioning, and after pause/resume.
- Codex app-server accepted the experimental `initialize` handshake.
- Actual Zuse Serve startup completed, created SQLite storage, and responded to
  HTTP. The provider adapter's hosted endpoint returned expected unauthenticated
  HTTP 401, both before pause and after resume.
- Normal stop reached `archived` with a completed snapshot. The real provider
  adapter resumed the machine and reconstructed its persistent home links.
  A saved marker survived; SQLite `quick_check` returned `ok` after resume.
- The `zuse` user could not use sudo before or after resume.
- Provider tests: 70 passed. Runtime-asset tests: 21 passed. Toolchain updater
  tests: 5 passed. Server types, applicable Biome, and shell syntax checks passed.

## Additional finding and fix

The old `zuse-host-ports.service` failed repeatedly with `ASCII_TOKEN environment
variable is not set`. Its systemd environment lacks Boat command credentials.
Removed that redundant service and its install/start steps. The provider adapter
already owns port registration through the authenticated command channel, after
its listener starts; the live hosted-endpoint checks exercised that path.
Reinstalled the final template payload successfully without the service.

## Default agent availability observed

| Command | Observed state |
| --- | --- |
| `claude` | Ready, version 2.1.281 |
| `codex` | Ready, version 0.156.1 |
| `opencode` | Ready, version 1.18.32 |
| `cursor-agent` | Launcher present; first-run installation needs root, fails as `zuse` |
| `grok`, `gemini`, `amp`, `droid`, `goose`, `aider`, `copilot`, `kiro-cli` | Not on PATH |

This is an observed inventory of this base image, not a guarantee about every
Boat image or future version. Successful CLI startup does not prove all Zuse
provider integrations or all model features are compatible.

## Boundaries

The isolated machine had no Claude/Codex account login. Authenticated model
responses, model tool calls, desktop/mobile rendering, and the complete
account-image/credential-broker flow were not exercised. A new named template
was not published or forked. These remain rollout checks before production
promotion; the fresh installation and pause/resume tests do not replace them.

The shared pinned agent installers remain intentionally for E2B and its separate
authentication authority. Boat skips that stage entirely. Existing Boat account
images and workspaces are not migrated by this PR.
