# Account Quota

Track separate **Claude Code and Codex** account profiles. This extension owns
its credential reading, direct HTTP requests, response parsing, cache, and UI.
It never imports Zuse's quota collector or switches an agent's active account.

## Try it

1. Install Account Quota from Settings → Extensions and open its workspace tab
   in any local project.
2. Choose Claude Code or Codex. The usual credential path is filled in; change
   it for a separate profile. An account name is optional (`~/` is supported).
3. Click **Add account**, then **Refresh**. Repeat for each account; up to 20
   independent profiles are supported. Each account needs its own file.

Codex ChatGPT login files commonly live at `~/.codex/auth.json`; a separate
`CODEX_HOME` profile has its own `auth.json`. Required fields are
`tokens.access_token` and `tokens.account_id`. API keys are not subscription
quota credentials. Claude Code's JSON format uses `claudeAiOauth.accessToken`
and may include `expiresAt`; a file-backed login commonly uses
`~/.claude/.credentials.json`. On macOS Claude Code may store its login only in
Keychain: this preview requires a separately managed credential JSON file and
does not automatically read Keychain. Do not paste credentials into chat.

This is a credential-profile author preview, not an OAuth sign-in manager.
Reauthenticate expired profiles with their own CLI/configuration, then refresh.
The extension rereads files so renewed credentials are picked up. A path must
continue to belong to the labeled account; do not point multiple account cards
at one changing default login file.

## Data and failure behavior

Only labels and file paths are persisted in extension storage. Tokens are read
on demand, remain outside the renderer, and are sent only to the fixed provider
origin. Redirects are rejected. Responses are capped at 256 KiB, credential files
at 64 KiB, requests at ten seconds, with one account at a time and at most one
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

References: [Codex backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
and [Claude usage endpoint issue](https://github.com/anthropics/claude-code/issues/30930).
These are not guaranteed public quota APIs.

Run `bun run test` and `bun run check-types`. Fixtures are synthetic provider
responses. Live multi-account and macOS login checks require real accounts.
