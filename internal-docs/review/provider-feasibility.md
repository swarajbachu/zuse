# Hosted review provider feasibility

Milestone zero, inspected 2026-10-03. No provider is enabled. No account was authenticated, provider contacted, paid worker provisioned, or model request sent.

## Historical milestone-zero findings (superseded pin)

The repository locks Codex to 0.155.1 and the Claude Agent SDK to 0.2.126. The environment's Conductor binaries report Codex 0.159.3 and Claude Code 2.1.286. They are not proof for the repository's production pins. Package dependencies and the documented local reference checkout were absent at initial inspection.

After installation, the production-pinned Codex binary reports 0.155.1, SHA-256 `0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761`; the SDK binary reports Claude Code 2.1.126, SHA-256 `fce96968d275161ff65a4c19fc6434efc6973d9f6d35dc3992a2ba0553cac18e`. Probe the native executables in `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex` and `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, not the JavaScript CLI wrapper. Pinned Claude advertises tools/settings/strict-MCP options but lacks the newer restricted/safe-mode flags. No inference or native login was exercised.

The existing Claude driver auto-allows filesystem reads and connects user MCP servers. The existing Codex driver configures sandbox/approval modes and the general Zuse MCP gateway. Neither establishes a review-only tool boundary. Read-only execution can still read credentials.

After dependencies were installed, the locked SDK's `sdk.d.ts` established that `allowedTools` only auto-approves tools; it is not a strict availability allowlist despite the existing driver's comment. The SDK documents `tools: []` as removing all built-in tools and `settingSources: []` as disabling filesystem settings. These are promising inputs for a future profile, but do not prove native authentication, hook/plugin exclusion, managed settings or custom MCP confinement under adversarial execution. General agent behavior is unchanged in this milestone.

Claude 2.1.286 help advertises `--tools`, `--restricted`, `--safe-mode`, settings-source selection, and strict MCP configuration. These are candidates, not tested isolation. `--bare` explicitly disables OAuth/keychain, so it is unsuitable for this subscription product. Safe mode disables custom MCP as well; restricted mode still permits managed settings. Their interaction with a trusted read/search MCP and native subscription auth needs proof against the production pin. Codex app-server help advertises config overrides but does not establish a complete native-tool suppression profile.

## Repeatable inspection

Run without credentials or inference:

```sh
node packages/agents/scripts/probe-review-provider.mjs codex /absolute/path/to/codex
node packages/agents/scripts/probe-review-provider.mjs claude /absolute/path/to/claude
```

The probe hashes the exact binary and collects only version and advertised help flags. It uses a restricted environment and trusted cwd, never reads account files, and never starts a session. Its successful exit means inspection completed, not provider eligibility. A reviewed binary hash, supported version and actual adversarial execution evidence are required before implementation of a launch profile.

## Eligibility API

`@zuse/agents/review/eligibility` exports `getReviewProviderEligibility(providerId)`. Both known providers return `blocked` with authorization, native-tool-confinement and durable-native-auth reasons; unknown identifiers return `unsupported-provider`. It accepts no caller attestations or feature-flag overrides. Integration must check before enrollment and dispatch. The dedicated Claude execution implementation is exported separately, but this admission API still blocks production enrollment/dispatch; implementation availability is not release approval.

The server's `runNativeReviewWorker` checks this admission gate before calling the real native factory. The separately built worker runtime requires an authenticated, current control-plane bootstrap before running that factory. Its internal `runReviewWithAdapter` harness composes the engine with explicitly injected trusted sessions, closes each session after use, aborts on cancellation/deadlines, and refuses to return an artifact when shutdown cannot be confirmed. It does not provision workers or bypass the production gate. The worker supervisor must terminate the entire worker on uncertain shutdown. The dedicated clean image excludes general workspace bootstrap, repository setup scripts, inherited agent configuration and credentials; existing general-purpose images are not approved review images.

## Required proof before adding an eligible profile

1. Record authorization for paid hosted unattended subscription review, separately covering personal and shared repository enrollments. User consent alone is insufficient. Keep shared connection ownership and repository delegation explicit.
2. Pin and hash the unmodified provider binary. Run outside the checkout with one private native-auth home in a dedicated paused/resumed sandbox per connection. Native login/refresh/logout must work without central collection of subscription credentials. Verify restart, exclusive leasing, revocation, sandbox loss and reconnect account matching. Placement without suitable persistent storage is ineligible; sandbox loss requires native login again.
3. Serve immutable repository snapshots through a separate trusted read/search MCP process with no auth mount. Remove or enforce-deny native shell, arbitrary read, browser, network tools and delegation; disable executable hooks/plugins/project settings and all other MCP. Test malicious instructions/config, symlink traversal, absolute paths, `/proc`, environment reads and secret canaries. Observe process/network behavior, not just model output. Trusted managed settings must also be audited.
4. Verify auth expiry, quota exhaustion, partial streams and crashes stop workers without false success or fallback charges. No provider credential or GitHub write token may enter prompts, tool output, logs or repository snapshots. Native provider networking is allowed only for the provider's operation; repository tools cannot use it.
5. Repeat the gate after binary, tool configuration or confinement changes. If an unmodified binary cannot satisfy the gate, leave it unavailable. Do not substitute API billing or weaken the boundary.

## Provider evidence

[Anthropic's official policy](https://code.claude.com/docs/en/legal-and-compliance) permits end-user sign-in to hosted unmodified Claude Code but disallows third-party credential collection/intermediation and assumes ordinary individual subscription usage. This does not establish permission for shared unattended review. [Authentication guidance](https://code.claude.com/docs/en/iam) supports separate native configuration homes.

[OpenAI authentication](https://learn.chatgpt.com/docs/auth) documents native subscription login and trusted automation while recommending API keys for general automation. [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) directs paid or remotely hosted applications to its interest process. Neither a successful login nor the presence of Zuse's existing credential broker proves this review service is authorized. Provider confirmation remains outstanding; API billing is not a fallback for this feature.


## Implemented hosted worker (2026-10-07)

The rebased repository pins Claude Agent SDK **0.3.276**, native Claude Code **2.1.276**, SHA-256 `8a56c8a14bd3cb246e2bdb7e60aefe0f609bff78c8bbcc5ea6b1817c111c6145`. The older hashes above are historical evidence only. General agent drivers are unchanged.

- `packages/agents/src/review/claude-profile.ts` configures the existing SDK's unmodified native binary: `tools: []`, `settingSources: []`, `strictMcpConfig`, no skills/plugins/agents/hooks, disabled memory/checkpoint/session persistence, no inherited environment, and deny-by-default permission callback. Only trusted bounded SDK MCP tools are auto-approved. Each query has a fresh cwd and process group with bounded parent shutdown.
- `apps/server/src/review/native-adapter.ts` runs actual structured native investigation and independent verification, using the authoritative engine schema. The verifier receives the candidate and immutable snapshot, not the investigation transcript. Malformed/missing native structured output fails rather than parsing free-form prose.
- The dedicated image has a trusted root supervisor; the native process runs as uid 1000, authhome 0700/credentials 0600, and the reader process runs as uid 1001 against immutable Git objects in its own 0700 directory. Neither child inherits the attempt/GitHub token. UID separation denies reader auth reads and native filesystem reads of the repository. The native process can still access its own authhome internally; preventing model-directed access additionally depends on the unmodified binary's confinement proof.
- `reader-service.ts` exposes bounded read/search requests and static import metadata, with an isolated in-memory index. Git hooks, filters, external diff, setup scripts, repository instructions and tests are never executed in the native-auth sandbox. The supervisor supplies the SDK MCP facade from these capabilities; it exposes no general shell/filesystem operation.
- `worker-runtime.ts` obtains one leased bootstrap, fetches exact commits without persisting GitHub authorization, derives the merge base, checks leases before inference/tools plus background heartbeat, stops analysis 45 seconds before the hard deadline, joins native/reader processes, removes per-run data, and uploads the result. Cleanup uncertainty or abandoned lock means destroy/reconnect, never pause/reuse uncertain processes. A control-plane stale attempt cannot receive a new bootstrap.
- `native-login.ts` starts native subscription login as uid 1000. It publishes only an allowlisted OAuth challenge and accepts a one-use callback URL matching the native-announced loopback origin/path/state/expiry. A 0600 callback file is removed before forwarding. The native process exchanges tokens itself. Ready requires child exit, private native credentials, and the SHA256 fingerprint of the native account UUID. Account metadata placement and browser callback flow require live staging confirmation. No tokens are returned to the control plane.
- `check-runner.mjs` is a separate credential-free image. It runs base-approved root test/typecheck/check-types commands identically at merge-base and head, under uid 1001, with bounded output/deadlines. Dependency preparation supports bounded declared npm/Bun workspaces and catalogs, using registry-only frozen installs with lifecycle scripts disabled; the controller removes network access before checks. Non-registry dependencies, manager config, symlinks and binary Bun lockfiles return inconclusive rather than silently executing setup. This runner never enters the subscription sandbox.

Reproduce credential-free validation:

```sh
node apps/server/scripts/build-review-worker.mjs
sudo node apps/server/scripts/probe-review-isolation.mjs
sudo node apps/server/scripts/probe-review-checks.mjs
```

The build emits a worker/binary hash manifest with `releaseApproved: false`; image build contexts are `apps/server` with `review-image/Dockerfile` or `review-image/Dockerfile.checks`. Isolation probe passed real UID canaries (auth, repository and root `/proc`), actual bundled immutable read, indexed search and static relationships. Check probe passed base-success/head-failure, root status protection, absent child credentials, parent-environment denial, timeout and missing-script reporting. Unit tests cover native options, account-directory permissions, one-use session structure and callback substitution/expiry.

**Outstanding release proof:** paid hosted/subscription and shared-identity authorization; adversarial native inference/tool inventory under this exact binary; native login/refresh/account-match and sandbox pause/resume; infrastructure image/network/timeout staging and real end-to-end publication. These local checks are not substitutes. No provider request, actual authentication, paid sandbox or GitHub write occurred during implementation.
