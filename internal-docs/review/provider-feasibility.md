# Hosted review provider feasibility

Milestone zero, inspected 2026-10-03. No provider is enabled. No account was authenticated, provider contacted, paid worker provisioned, or model request sent.

## Findings

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

`@zuse/agents/review/eligibility` exports `getReviewProviderEligibility(providerId)`. Both known providers return `blocked` with authorization, native-tool-confinement and durable-native-auth reasons; unknown identifiers return `unsupported-provider`. It accepts no caller attestations or feature-flag overrides. Integration must check before enrollment and dispatch. No executable review profile is exported until there is an enforceable implementation.

The server's `runNativeReviewWorker` always throws `ReviewProviderUnavailableError`. Its internal `runReviewWithAdapter` harness composes the engine with explicitly injected trusted sessions, closes each session after use, aborts on cancellation/deadlines, and refuses to return an artifact when shutdown cannot be confirmed. It does not provision workers or bypass the production gate. The worker supervisor must terminate the entire worker on uncertain shutdown. A future clean image must exclude general workspace bootstrap, repository setup scripts, inherited agent configuration and credentials; existing general-purpose images are not approved review images.

## Required proof before adding an eligible profile

1. Record authorization for paid hosted unattended subscription review, separately covering personal and shared repository enrollments. User consent alone is insufficient. Keep shared connection ownership and repository delegation explicit.
2. Pin and hash the unmodified provider binary. Run outside the checkout with one private native-auth volume per connection. Native login/refresh/logout must work without central collection of subscription credentials. Verify restart, exclusive attachment, revocation, volume loss and reconnect account matching. Placement without suitable persistent storage is ineligible; volume loss requires native login again.
3. Serve immutable repository snapshots through a separate trusted read/search MCP process with no auth mount. Remove or enforce-deny native shell, arbitrary read, browser, network tools and delegation; disable executable hooks/plugins/project settings and all other MCP. Test malicious instructions/config, symlink traversal, absolute paths, `/proc`, environment reads and secret canaries. Observe process/network behavior, not just model output. Trusted managed settings must also be audited.
4. Verify auth expiry, quota exhaustion, partial streams and crashes stop workers without false success or fallback charges. No provider credential or GitHub write token may enter prompts, tool output, logs or repository snapshots. Native provider networking is allowed only for the provider's operation; repository tools cannot use it.
5. Repeat the gate after binary, tool configuration or confinement changes. If an unmodified binary cannot satisfy the gate, leave it unavailable. Do not substitute API billing or weaken the boundary.

## Provider evidence

[Anthropic's official policy](https://code.claude.com/docs/en/legal-and-compliance) permits end-user sign-in to hosted unmodified Claude Code but disallows third-party credential collection/intermediation and assumes ordinary individual subscription usage. This does not establish permission for shared unattended review. [Authentication guidance](https://code.claude.com/docs/en/iam) supports separate native configuration homes.

[OpenAI authentication](https://learn.chatgpt.com/docs/auth) documents native subscription login and trusted automation while recommending API keys for general automation. [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) directs paid or remotely hosted applications to its interest process. Neither a successful login nor the presence of Zuse's existing credential broker proves this review service is authorized. Provider confirmation remains outstanding; API billing is not a fallback for this feature.
