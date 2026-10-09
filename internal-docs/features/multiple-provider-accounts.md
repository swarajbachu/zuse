# Multiple Claude and Codex accounts

Built-in agents and ACP agents use separate native CLI configuration directories for each named account. The approach follows [monocode's account isolation](../research/monocode-multiple-accounts.md); OAuth login, renewal, and credential storage remain owned by the native CLI.

## Built-in agents

Expand Claude or Codex in provider settings, add an account, and sign in. Rename accounts to distinguish work, personal, or organization subscriptions. Select **Use for new chats** before sending the first message. The default CLI login / API key option preserves the existing shared CLI login and managed credential behavior.

Account metadata and the preferred account live in SQLite. Each session's account is recorded separately on its first provider start and retained across reconnects and server restarts. Existing sessions are migrated to the default login. Native forks inherit their source session's account. Changing the preference affects subsequent unbound chats, including already-created empty chats.

Named homes live under `provider-accounts/<provider>/<id>` in the computer's Zuse user-data directory. Claude receives both `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`; Codex receives `CODEX_HOME`. Inherited authentication overrides and managed/brokered credentials are excluded from named-account processes, probes, login, and usage requests. The parent process environment is unchanged.

Named built-in accounts are available on local and SSH computers. Cloud workspace runtimes retain their existing brokered authentication. Account configuration and credentials do not sync between computers.

## ACP agents

Use **Add account** on a Claude or Codex ACP agent. Rename the new entry and authenticate through its normal ACP authentication action. Select the resulting agent entry in the chat provider picker. Every account has its own stable ACP instance ID and home under the ACP store's `accounts/<instance-id>` directory. Duplicating a named account creates a fresh login home rather than copying its credentials.

Saved environment variables cannot override a named account's home. Probes, authentication terminals, and execution use the same isolation. Catalog updates retain the account ID and home.

## Removal and verification

Removing an account removes its settings entry, not its credential directory or transcript files. Existing live processes retain their environment snapshot. Resuming a session whose named account was removed fails explicitly instead of choosing a different login. Deleting a session removes its account binding through the existing SQLite foreign-key cleanup.

Automated checks cover account persistence, preferences, legacy sessions, forks, removal, per-process environment isolation, catalog updates, usage filtering, and disabling Codex broker authentication for named accounts. Browser checks use mocked RPCs and login events. Real OAuth approval and macOS Keychain isolation require testing with Claude/Codex accounts on macOS.
