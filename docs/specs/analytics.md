# Product analytics contract

Zuse Alpha collects default-on, pseudonymous product and reliability analytics from the desktop and mobile apps. The marketing website is excluded. Users can disable collection immediately from either app under **Share usage analytics**.

The implementation uses one production project and platform-specific public ingest keys. Development and tests are disabled unless an explicit test project is configured. Operations credentials are restricted to `scripts/provision-analytics.mjs` and must never be included in an app bundle.

## Development

Copy `.env.analytics.example` to the ignored root `.env`, add the public ingest
keys, and set the matching `*_POSTHOG_ENABLE_DEV` values to `1`. Desktop
development uses `ZUSE_POSTHOG_*` for backend events and `VITE_POSTHOG_*` for
renderer events. For local Expo development, copy the same values into the
ignored `apps/mobile/.env`; mobile uses `EXPO_PUBLIC_POSTHOG_*`.

Leave the development flags at `0` when a developer should not send local
activity. Production builds enable delivery from their build mode and do not
depend on these flags.

## Privacy boundary

Allowed events and properties are versioned in `packages/analytics`. Unknown events and properties are discarded. Known catalog models may use their normalized ID; custom models are recorded as `custom`.

Tool results never produce individual analytics events. Their category totals
and failures are accumulated in memory and attached to `turn completed`, `turn
failed`, or `turn interrupted`. A turn with one tool call and a turn with one
thousand tool calls therefore have the same tool-analytics event volume. Other
product analytics—including screens, controls, onboarding, lifecycle,
connectivity, subagent, and compaction events—remain enabled.

The following must never be captured: prompts, responses, reasoning, tool input or output, commands, source code, file or repository names, paths, URLs, branches, entity IDs, titles, arbitrary integration names, diagnostic contents, names, email addresses, organization IDs, credentials, tokens, or error stacks. Errors use stable codes and fingerprints only.

Signed-out installs use a random local identity. Signed-in clients use a namespaced SHA-256 account hash so desktop and mobile activity can be measured together without sending the account identifier. Signing out, resetting the app, or deleting an account rotates to a fresh anonymous identity. Previously collected pseudonymous aggregate history is retained. Standard geographic enrichment is applied by the analytics processor.

Autocapture, session replay, remote feature flags/configuration, and
exception/source capture are disabled. Active time counts only while the app is
foregrounded and the user has interacted within 60 seconds, and is emitted in
aggregate intervals.

Managed dashboards and actions filter on
`analytics_schema_version = 2`. Existing schema-v1 raw history remains intact
for audit and comparison, but is excluded from current product reporting.

## Release gate

- Review the privacy policy and in-product disclosure.
- Configure public production ingest keys and the US ingestion host.
- Run `node scripts/provision-analytics.mjs` with an operations-only credential.
- Verify opt-out before first capture on desktop and mobile.
- Confirm bundles contain no operations credential or replay package.
- Inspect a canary payload and confirm every property is allowlisted.
