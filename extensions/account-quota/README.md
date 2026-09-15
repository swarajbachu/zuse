# Account Quota

Track separate **Claude Code and Codex** account profiles. This extension owns
its credential reading, direct HTTP requests, response parsing, cache, and UI.
It never imports Zuse's quota collector or switches an agent's active account.

## Try it

1. Install/update **Account Quota 0.2.0** in Settings → Extensions, then open its workspace tab.
2. Click **Connect Codex** or **Connect Claude Code**. The extension reads the CLI login and fetches quota in the same action. No account name or file path is needed.
3. On macOS, allow Keychain access if prompted. Keychain is read only on Connect/Refresh, never on startup or while listing accounts.

Current-login cards follow whichever account is signed into that CLI; they do not switch accounts. Codex uses `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) with a macOS `Codex Auth` Keychain fallback. Claude Code uses its standard macOS `Claude Code-credentials` Keychain entry, or a credentials file on other platforms. Custom `CLAUDE_CONFIG_DIR` locations use `.credentials.json` inside that directory.

If no login exists, sign in using `codex login` or Claude Code's `/login`, then connect again. API-key logins do not expose subscription allowances. Expired tokens are not renewed by this extension; reauthenticate in the CLI. Nonstandard/managed credential stores may require an explicit file profile.

**Additional accounts:** choose **Add a separate account…** and point each card at its own credential JSON file. Up to 20 accounts are supported. A separate `CODEX_HOME` has its own `auth.json`. Claude files contain `claudeAiOauth.accessToken`; Codex files contain `tokens.access_token` and `tokens.account_id`. Do not paste credentials into chat or reuse one changing default file for several named accounts.

## Data and failure behavior

Only labels, source selection, and file paths are persisted in extension storage. Tokens are read
on demand, remain outside the renderer, and are sent only to the fixed provider
origin. Redirects are rejected. Responses are capped at 256 KiB, credential files
at 64 KiB, requests at ten seconds for provider requests and fifteen seconds for Keychain access, with one account at a time and at most one
attempt per account per minute. Refresh is manual. Old readings remain visibly
labeled after failures; unavailable data never becomes a full-quota reading.

Removing a profile does not delete its credential file. Disable/remove stops
requests. Account configuration survives disable/re-enable. Endpoint formats
are provider-controlled and can change or reject third-party requests.

## Author your own collector

`providers.ts` owns the `QuotaSource` interface (`request` + `parse`); add or
replace collectors there. `index.server.ts` owns profiles, bounded file reads,
cancellation and lifecycle. `contracts.ts` defines typed RPC; `index.client.tsx`
is the UI. Zuse supplies generic storage/RPC, not provider quota logic. Another
extension can own OAuth connections using extension secret storage instead of
these file references, without depending on this extension.

Credential-store reference: [Codex auth storage](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs).

References: [Codex backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
and [Claude usage endpoint issue](https://github.com/anthropics/claude-code/issues/30930).
These are not guaranteed public quota APIs.

Run `bun run test` and `bun run check-types`. Fixtures are synthetic provider
responses. Live multi-account and macOS login checks require real accounts.
