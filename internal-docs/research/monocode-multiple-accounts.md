# Multiple Claude and Codex accounts in MonoCode

**Date:** 2026-10-09
**Scope:** source research for isolated account profiles in Zuse
**Source revision:** `d68bfa8768b2f7e61686a5925c8d26e20cf6cba0`

## Reusable approach

MonoCode supports named accounts specifically for Claude Code and Codex. An
account is a stable ID, provider, and user-facing label; credentials stay in the
provider CLI's storage. Additional profiles use
`<app-data>/provider-accounts/<provider>/<account-id>`. The implicit `default`
profile preserves the user's existing CLI login. IDs are validated before they
become paths. Metadata and project-level account selections live in localStorage;
this persistence choice is specific to MonoCode, not a requirement for Zuse.
Sources: [account model](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/features/providers/model/providerAccounts.ts),
[native profile paths](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/harness.rs#L986-L1029).

The important isolation boundary is the spawned process environment:

| Provider | Profile selectors | Inherited credential overrides removed |
| --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `CODEX_HOME` | `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` |

Both Claude selectors receive the same exact directory string. MonoCode's source
explains that Claude scopes ordinary configuration and macOS Keychain storage
separately; directory-only isolation would therefore be incomplete on macOS.
This is observed MonoCode behavior, not a claim that every ACP adapter or every
CLI version respects these variables. Source:
[environment application](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/harness.rs#L1070-L1100).

## Login, reconnect, and removal

MonoCode runs the provider's own login command (`claude auth login` or
`codex login`) in the same profile environment as agent sessions. The CLI opens
the browser and owns credential storage. Concurrent clicks share a login promise
keyed by provider and account, and login has a ten-minute timeout. A new account's
metadata is saved only after login succeeds. Reconnect logs into the selected
profile and refreshes its usage information. Sources:
[login supervisor](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/integrations/harness/core/auth.ts),
[login commands](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/integrations/harness/core/authSupport.ts),
[add/reconnect UI](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/app/shell/UsageFooter.tsx#L217-L290).

Removal terminates processes for that profile, deletes its Claude Keychain item
on macOS, and removes its profile directory before deleting UI metadata. The
default profile cannot be removed. MonoCode derives a custom Claude Keychain
service suffix from the first eight hexadecimal characters of the SHA-256 hash
of the NFC-normalized selector string. This is implementation-specific evidence;
Zuse should prefer provider-owned logout or otherwise validate compatibility
before depending on that derivation. Sources:
[native deletion](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/harness.rs#L1032-L1068),
[Keychain handling](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/rate_limits.rs#L595-L620).

## Session ownership and identity

Sessions persist `providerAccountId` in SQLite. Legacy sessions without an ID
belong to the default profile. Selecting another account changes an empty idle
chat; selecting another account in an existing conversation creates a new chat,
because native provider thread IDs belong to the original account. Sending in a
conversation whose account was removed produces an explicit error instead of
silently using another account. Sources:
[session persistence](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/session_store.rs),
[account comparison](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/features/providers/model/providerAccounts.ts#L9-L19),
[account switching](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/app/App.tsx#L2581-L2616),
[missing-account guard](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/app/App.tsx#L6815-L6837).

Display identity is read locally: Claude's `.claude.json` `oauthAccount` block,
or the claims payload of Codex's `auth.json` ID token. Tokens are not sent to a
separate identity service. These parsed claims are suitable for labels, not proof
of authorization. Usage and identity cache keys include both provider and account.
Sources: [identity parsing](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/account_identity.rs),
[account usage](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src/features/providers/model/accountUsage.ts).

Codex also has a separate per-account MonoCode conversation home. It shares
configuration and credential files with the chosen account while retaining its
own native rollouts and databases. For Keychain-backed credentials it mirrors
refreshes back only if the source has not independently changed, or the refresh
is newer for the same account. This extra store is not necessary merely to offer
multiple accounts, but illustrates why naive token copying can lose refreshes or
overwrite a newer login. Source:
[Codex private store](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/src-tauri/src/codex_mono_store.rs#L1-L220).

## Application to Zuse

Recommended adaptation, inferred from the source: reuse Zuse's provider
configuration, persistence, and process-launch paths to represent separately named
Claude/Codex profiles. Apply profile selectors consistently to native login, ACP
adapter launch, model discovery, usage lookup, and session resume. Keep every
running session pinned to its profile; a missing profile should fail explicitly.
Do not swap shared global credential files to change accounts. Verify adapter
environment forwarding and macOS Keychain isolation in real-provider smoke tests.

MonoCode's implementation is Rust/Tauri plus React, so a direct code transplant
would not fit Zuse's shared provider kernel. The useful reusable part is the
profile environment contract and account/session ownership behavior.

## License and validation

The source carries the MIT license, permitting reuse with its copyright and
permission notice retained in copies or substantial portions. Its NOTICE also
identifies provider marks as their owners' trademarks. Prefer independent
implementation of the observed design; preserve the MIT notice if any substantial
code is copied. Sources:
[LICENSE](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/LICENSE),
[NOTICE](https://github.com/hardbeat920/monocode/blob/d68bfa8768b2f7e61686a5925c8d26e20cf6cba0/NOTICE).

This note is based on reading the pinned source checkout and the upstream GitHub
repository. No provider credentials were used and no live login was attempted.
