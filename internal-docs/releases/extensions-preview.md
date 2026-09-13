# Extensions Preview launch preparation

Status: not published. This document is a release checklist and draft launch article, not a declaration of completed verification.

## Draft article

**Bring your project’s tools into Zuse.**

A failing test, an internal procedure, and a TODO comment have something in common: they are useful context for the next task. Zuse Extensions Preview brings those workflows into workspace tabs and lets you select exactly what reaches your agent.

Test Reports reads existing JUnit XML, exposes failures and their details, and attaches selected tests. Project Playbook turns repository Markdown into browsable sections with source references. Code Follow-ups scans on demand for TODO/FIXME comments and includes surrounding code. Install any combination; each tool has an independent lifecycle.

The workflow is explicit: browse locally, preview a result, attach it, and send through your usual composer. Browsing does not call an AI service. Attached text is a snapshot, so later file edits do not change what you chose.

This is an opt-in local desktop preview. Extensions execute trusted, unsandboxed code. Agent plugins, external-service integrations, ACP adapter catalogs, cloud execution, and mobile extension UI come later.

## Demonstration scripts

Record these from a working desktop build, with no personal data or live credentials visible:

1. **Failed tests → focused prompt (30–45 seconds).** Open the checkout JUnit fixture, inspect the expired-card failure, select it, attach, and compose “Fix this checkout failure while preserving the payment API.” Stop before sending to a live agent unless a deterministic fixture agent is configured.
2. **Team procedure → contextual task (30–45 seconds).** Open the deployment Markdown, select Recovery, attach, and compose “Use our recovery checklist to investigate the regression.” Show the source reference in the attachment.
3. **TODO comments → actionable work (30–45 seconds).** Scan the fixture workspace, filter refunds, inspect surrounding code, attach the finding, and compose “Implement partial refunds and test the edge cases.”

Captured real unsigned Linux desktop-package screenshots and three WebM recordings in `apps/web/public/extensions/demos/`. Each recording verifies read/scan → preview → selection → attach → ordinary composer. No prompt was sent. The public Extensions page embeds the recordings with captions. These demonstrate source-installed extensions in an unsigned Linux package, not signed catalog installation on a clean machine.

The packaged Linux and macOS hosts successfully installed all three source extensions and passed read/scan → preview → selection → attachment → composer workflows. Reload, disable, enable, removal with retained data, and reinstallation passed for each while the other extensions remained running.

Packaged verification exposed two issues, now fixed: intermittent module loading through `file://` (bundled renderer assets now use the existing standard `zuse://app` protocol with path-containment tests), and compiler/worker process paths inside ASAR (native launches now resolve physical unpacked paths through a shared helper). Five consecutive desktop reloads passed without page errors. The Linux AppImage/Debian packaging command completed after installing the VM's missing `libxcrypt-compat` prerequisite; the final fixes were verified in rebuilt Linux and universal macOS application directories. The unsigned macOS DMG and ZIP build also completed. macOS runtime verification used Apple Silicon; Intel runtime execution and clean-machine installation remain unverified.

## Publication order and gates

- Pass host, renderer/server, SDK, extension, architecture, type, Biome, and bundle checks.
- Verify clean-machine packaged Linux and macOS catalog installs without Git/npm/Bun, followed by update, disable, removal, and coexistence flows.
- Provision the protected `extensions-release` environment and `EXTENSION_CATALOG_SIGNING_KEY`. The signing workflow verifies that the actual credential matches the shipped Ed25519 public key. A source comment does not establish provisioning.
- Publish the staged SDK package to npm with the preview tag; verify standalone `zuse extension init` against the public registry.
- Build official artifacts from the exact release commit. Sign the catalog, verify digests, and deploy immutable artifacts before the catalog/signature pair.
- Release the desktop preview, documentation, screenshots, and demonstrations; verify the public install path.

Current credential evidence: npm authentication is unavailable; the current GitHub token receives HTTP 403 when listing repository signing-secret metadata. The exact Conductor-synced workspace on macOS 26.6.2 is accessible, and compiler/renderer source hashes match this workspace. Unsigned universal macOS packaging completed. The packaged app passed all three attachment workflows and reload/disable/enable/remove/reinstall checks in an isolated test profile. Signing, public SDK installation, and clean-machine signed catalog verification remain release blockers.

## Verification evidence

- All 36 workspace type-check tasks and architecture boundary checks pass.
- Applicable Biome checks pass; seven existing warnings and two informational diagnostics remain in `chat-composer.tsx`.
- Renderer unit tests: 120 files / 555 tests pass. Server unit tests: 57 files / 343 tests pass. Server integration tests: 25 files / 223 tests pass. Renderer integration target has no tests.
- Final host regressions: 20 tests pass, including crash-loop recovery, staged-state rollback, failed configuration commit, interrupted generation cleanup, concurrent lifecycle changes, cancellation, startup deadline, secret-write prevention, compiler boundaries, signature/digest tampering, offline retention, and queue overflow.
- Official extension fixtures, shared workspace/index behavior, and SDK cleanup/isolation tests pass. The new packaged renderer asset containment test passes. Two host tests hit their 5-second test-runner deadline during a concurrent packaging run; the host suite passes with one worker.
- Renderer bundle budgets pass. Desktop startup smoke, Linux packaging, universal unsigned macOS packaging, and the public website production build pass. Documentation validates 82 internal routes.
- Packed SDK dependency installation and TypeScript checks pass in a standalone temporary project outside the monorepo. Three unsigned precompiled catalog artifacts validate; they are not publishable until signed.
- Real packaged Linux recordings are under `apps/web/public/extensions/demos/`. No test prompt was submitted to an agent. Packaged lifecycle verification used the desktop's ordinary RPC surface; the recordings exercised the actual UI attachment flows.

No merge, npm publication, catalog deployment, or desktop release has occurred. Public signed catalog installation, official update delivery, release credentials, and clean-machine Intel/macOS/Linux validation are outstanding. Existing installed extensions are retained when the catalog is offline; that behavior is covered by a signed fixture-catalog test, not evidence of a publicly deployed catalog.

## Main-branch integration verification (September 13)

Merged main through `32dc3078`, including the desktop/website localization release and mobile account-deletion clarification. Preserved the lazy main shell, refreshed composer, shared command palette, live model catalog, and sidebar grouping while keeping extension panels, commands, and attachments available. Host extension controls now use the shared localization package; new translations are drafts, subject to the same review gate as main. Extension-authored tool content remains English.

The latest integration checks include 837 renderer tests and 44 extension/SDK/model-catalog tests. Renderer default-route JavaScript is 496.6 KiB gzip against the unchanged 500 KiB budget; optional SDK modules and extension surfaces load separately. See [the hands-on test guide](extensions-preview-testing.md) for the prioritized workflows and language-switch checks. macOS interaction testing for this latest merge is deferred to the user; prior packaged evidence above predates the multilingual merge.

Final merge checks also passed: all 39 workspace type-check tasks; applicable Biome (existing composer diagnostics remain); localization validation (2,461 desktop messages plus 294 website messages); localization unit tests; 440 server unit tests; desktop build/startup smoke; Linux packaging; all three packaged attachment workflows and independent lifecycle flows. Desktop tests passed 191 initially, and the two filesystem-sync tests passed after installing the sandbox’s missing `rsync`. The 246 server integration tests passed after the first main merge, before the localization-only second merge. A fresh Mac build could not be confirmed through the local connection; do not count the latest merge as Mac-verified.
