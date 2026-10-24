# Public usage profiles

Users can publish an aggregate year-to-date snapshot from **Usage → Publish profile** in a Personal workspace. The dialog previews token totals, active days, longest streak, and model count. A Zuse account is required to publish. Organization workspaces do not expose this action.

The public URL is `https://zuse.sh/u/<handle>`. The handle is permanent and remains reserved after unpublishing. Users can change their display name and optional GitHub username, update the snapshot, or unpublish it. Unpublishing removes anonymous access on the next request. It cannot remove copies someone has already downloaded.

## Data and meaning

Snapshots contain an explicit display name, handle, optional GitHub username, UTC year and generation timestamp, and aggregate counts: daily token totals, model totals, model mix per UTC month (top 8 models plus a remainder), token categories, per-tool totals (Claude Code, Codex, and so on), project count, session count, and median and longest session minutes. Two sections are opt-in and published as `null` unless the user turns them on: an API-equivalent cost estimate (`complete: false` when some usage has no price) and tokens per hour of day in the publisher's local time. Publication timestamps are assigned by the API. Raw usage reports are never uploaded: chats, project names, session identifiers, source paths, and individual records are excluded by the projection and API schema.

The desktop server builds the snapshot through `usage.profile.snapshot`, so raw records never reach the renderer. The API rejects snapshots whose sections disagree: model, month, category, and tool totals must equal the daily total, and hours may not exceed it. Session length spans first to last activity in a session; restored daily aggregates are excluded from hours and session lengths.

Data comes from the selected environment across all projects, covering January 1 through the preview's generation time. This is a manually updated, self-reported snapshot rather than a live or verified account-wide measurement. Imported usage can be included. Sessions are distinct usage sessions with a session id, not prompt counts; records without a session id and restored daily totals are not counted as sessions. Tokens use the same sum of input, output, cache read, cache creation, and reasoning categories as the existing Usage dashboard. Source tools can differ in their category accounting.

Active days and streaks use positive daily token counts. The current streak is evaluated as of the snapshot date; an unfinished inactive day does not break yesterday's streak. Streaks are bounded by the displayed year. Weekly bars start on Sunday. Future dates are outside the snapshot, rather than recorded zero-usage days.

Prompt counts are not included because the existing usage report does not provide an authoritative prompt event count.

## Ownership

- `packages/contracts/src/usage-profile.ts`: aggregate schemas and desktop RPC contracts.
- `packages/utils/src/usage-profile.ts`: allowlisted projection, cross-section validation, activity calculations, and public URL.
- `apps/server/src/usage/handlers.ts`: `usage.profile.snapshot` builds the UTC year-to-date snapshot from local records.
- Renderer: ClientBus requests the environment snapshot and applies the cost and time-of-day switches; the existing account control transport manages publishing. Account changes close the old dialog and discard old responses.
- API: `GET`, `PUT`, and `DELETE /v1/usage-profile` require WorkOS account authentication. The public read is `GET /v1/public/usage-profiles/<handle>`. Writes use bounded bodies, calendar/count validation, and an atomic account/handle claim. Account deletion removes the profile.
- Website: `/u/<handle>` fetches the API with `no-store` and a bounded timeout. Missing or unpublished profiles render an unavailable page; service failures render a retry state. Pages are excluded from indexing. Profile snapshots are never added to the sitemap.

## Rollout

1. Apply API migration `0048_public_usage_profiles.sql` using the existing migration procedure. It adds a new table without modifying existing runtime data.
2. Deploy the API with the new store methods and routes.
3. Deploy the website. `ZUSE_API_URL` selects the server-side profile API; it defaults to the production API. For staging or local testing, point it at the corresponding staging/local API. Production share links target `zuse.sh`, so staging publications must be checked on a website connected to the staging API.
4. Release the desktop/hosted renderer and its server together with the new RPCs.
5. Verify publish, update, copy, and unpublish using a test account, and confirm the anonymous URL stops serving the profile after unpublishing.

## Checks

- API routes: `bunx vitest run infra/api/test/unit/usage-profile-routes.test.ts`
- Activity/projection: `bunx vitest run packages/utils/test/unit/usage-profile.test.ts`
- PostgreSQL atomicity/restart: `ZUSE_TEST_POSTGRES_URL=<test database> bunx vitest run infra/api/test/integration/usage-profile.pg.test.ts`. Uses a temporary schema; skipped without a test database.
- Renderer browser flow: `node apps/renderer/test/integration/usage-profile.browser.mjs`. Uses stub transports and system Chrome by default; `CHROME_PATH` can select a browser executable.

## Usage history and account backup

Source tools rotate their logs (Claude Code keeps about 30 days), so the desktop server keeps durable history in SQLite:

- `usage_history` (migration `0093_usage_history`): hourly rows keyed by source, model, session id, and project path, written monotonically by the usage poller every 6 hours and whenever usage loads. A row gets the next `change_seq` (a database counter, not wall-clock time) only when it grows, so incremental backup is unaffected by clock changes. Rows feed every usage view: per key, live records win unless the stored row counted more tokens, meaning its log was trimmed. Legacy `usage_cost_daily` rows are read-only and fill only days without hourly history.
- **Opt-in account backup** (`Usage → Back up`, personal workspace, signed in): bound to the account that enabled it, synced at most every 3 days by the usage poller and immediately on enable. Uploads contain hourly token and cost totals; session and project ids are replaced by HMAC-SHA-256 keys (128-bit) using a per-account key from `GET /v1/usage-history/key`, so every device hashes the same session identically. Only rows changed since the last upload are sent, plus legacy daily rows once. The API merges monotonically, so retries, reinstalls, and multiple devices converge to the largest count per key.
- Rows the API would reject (shared rules in `@zuse/utils/usage-history`) are skipped and logged, so one bad row cannot block backup. Account uploads are refused with `409 usage_history_backup_disabled` unless the switch is on at write time.
- Each sync downloads the whole account copy into `usage_history_remote`, recorded together with the account and key it belongs to; the profile ignores a cache from another account. With backup on, local records are re-keyed to the same hashed ids before merging, so one session or project has one identity across devices. If the profile is published, the sync refreshes it with `If-Match: <updatedAt>`; the API returns `412 usage_profile_changed` if the owner unpublished or changed it meanwhile, and the refresh is dropped.
- **Account switch.** `GET/PUT /v1/usage-history/settings` holds the account-level choice. Enabling on a device turns it on; each desktop sync checks it and stops locally once it was turned off elsewhere. A changed account key (the copy was deleted and recreated) makes every device re-upload its full history.
- **Personal cloud workspaces** compute usage from the logs inside their sandbox like any environment. Every hour the usage poller in the workspace fetches `GET /v1/cloud/workspaces/:id/runtime/usage-history/key` with its runtime credential and, when the owner's backup is on, uploads changed hourly rows to `PUT .../runtime/usage-history`. The API attributes rows to the owning account, refuses organization-owned workspaces (403), and returns 409 while backup is off. Rows use the same keyed hashes, so the owner's profile includes cloud usage after the next desktop sync, without double counting. Usage recorded in the last hour before a workspace is deleted can be lost.
- Turning backup off stops syncing and clears the local cache; "Delete the account copy" also calls `DELETE /v1/usage-history`, which removes rows and the key. Account deletion removes both.
- The hash key is stored by the API, so hashes keep identifiers out of casual view but are not secret from the service itself. Paths and chats are never uploaded.

API: `infra/api/src/usage-history-routes.ts`, migration `0049_usage_history.sql`. Uploads are batches of at most 2,000 rows (1.5 MiB), validated per row (real UTC hour, not in the future, `firstAt` within the hour), with a 1,000,000-row cap per account (`413 usage_history_full`). Pages are keyset-paginated by id.

Rollout adds: apply API migration `0049_usage_history.sql`; the desktop migration runs automatically.
