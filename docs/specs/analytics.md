# Product analytics contract

Zuse Alpha collects default-on, pseudonymous product and reliability analytics from the desktop and mobile apps. The marketing website is excluded. Users can disable collection immediately from either app under **Share usage analytics**.

The implementation uses one production project and platform-specific public ingest keys. Development and tests are disabled unless an explicit test project is configured. Operations credentials are restricted to `scripts/provision-analytics.mjs` and must never be included in an app bundle.

## Privacy boundary

Allowed events and properties are versioned in `packages/analytics`. Unknown events and properties are discarded. Known catalog models may use their normalized ID; custom models are recorded as `custom`. Tools are limited to `browser`, `shell`, `files`, `git`, `mcp`, `subagent`, and `other`.

The following must never be captured: prompts, responses, reasoning, tool input or output, commands, source code, file or repository names, paths, URLs, branches, entity IDs, titles, arbitrary integration names, diagnostic contents, names, email addresses, organization IDs, credentials, tokens, or error stacks. Errors use stable codes and fingerprints only.

Signed-out installs use a random local identity. Signed-in clients use a namespaced SHA-256 account hash so desktop and mobile activity can be measured together without sending the account identifier. Signing out, resetting the app, or deleting an account rotates to a fresh anonymous identity. Previously collected pseudonymous aggregate history is retained. Standard geographic enrichment is applied by the analytics processor.

Autocapture, automatic screen and lifecycle events, session replay, remote feature flags/configuration, and exception/source capture are disabled. Active time counts only while the app is foregrounded and the user has interacted within 60 seconds, and is emitted in aggregate intervals.

## Release gate

- Review the privacy policy and in-product disclosure.
- Configure public production ingest keys and the US ingestion host.
- Run `node scripts/provision-analytics.mjs` with an operations-only credential.
- Verify opt-out before first capture on desktop and mobile.
- Confirm bundles contain no operations credential or replay package.
- Inspect a canary payload and confirm every property is allowlisted.
