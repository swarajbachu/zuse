# Product analytics contract

Zuse Alpha collects default-on, pseudonymous product and reliability analytics from the desktop and mobile apps. The website and documentation collect separately labeled public-site analytics. Users can disable collection immediately from either app under **Share usage analytics**.

The implementation uses one production project and a shared public ingest key across website and docs, and platform-specific app configuration. Development and tests are disabled unless an explicit test project is configured. Operations credentials are restricted to `scripts/provision-analytics.mjs` and must never be included in an app bundle.

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

## Acquisition and engagement reporting

`packages/analytics/src/public-site.ts` is the shared website/docs implementation.
Both production builds must receive the same `NEXT_PUBLIC_POSTHOG_KEY` and host
for the existing app project. The fallback order is `NEXT_PUBLIC_POSTHOG_*`,
`VITE_POSTHOG_*`, then `ZUSE_POSTHOG_*`. Development is disabled. Missing keys
silently disable collection, so a successful build alone does not verify delivery.

Website/docs use a first-party, Secure, cross-subdomain PostHog cookie with a
90-day rolling expiry. Anonymous browser identities can be shared between
zuse.sh and docs.zuse.sh. They are never linked to app accounts or app installs.
Do Not Track and Global Privacy Control prevent SDK initialization. Autocapture,
replay, surveys, and feature flags are disabled. URL queries, fragments, search
terms, ad identifiers, and profile updates are stripped. Public page paths,
referring origins, browser/device categories, and selected link destinations are
allowed on these public surfaces; the app's stricter content boundary is unchanged.

| Question | Measurement |
| --- | --- |
| How many visitors? | Unique `$pageview` identities, filtered to `surface=website` |
| How many download? | Total `website_download_clicked` events and unique clicking identities; this is intent, not completed transfers or installs |
| Website to download drop-off? | Ordered pageview to download-click to successful installer redirect, one-day window |
| Do download links work? | `website_download_resolved` separates installer redirects from release-page fallbacks; requests without an existing visitor cookie are excluded |
| Website to docs? | Website pageview, `website_docs_clicked`, docs pageview, `docs_page_engaged`, same identity, one-day window |
| How many use docs? | Unique docs pageview identities and weekly returning-reader retention |
| Do readers engage? | `docs_page_engaged`: once per page visit after 30 foreground/focused active seconds and 50% scroll; no search terms or copied text |
| How many chat creators? | Unique `chat created` identities on desktop |
| How many chats? | Total `chat created` events on desktop; durable creation precedes provider readiness |
| Where do app users drop off? | App open to chat creation to message submission to completed turn; separate onboarding funnel |
| Which devices? | Browser device/OS categories for public sites; desktop OS, CPU architecture, and app version |

`Zuse - Website acquisition`, `Zuse - Docs engagement`, and `Zuse - Desktop usage`
are managed from `scripts/analytics-dashboards.mjs`. Run the existing provisioning
script to upsert them. The older product dashboards now set aggregation on each
series (including unique active users and property sums) and give funnel steps
explicit increasing order. New dashboards use native typed PostHog queries.

Counts represent observed browser/install/account identities, not exact people.
Opt-outs, blockers, identity rotation, multiple browsers, and multiple installs
change counts. Historical website/docs activity cannot be reconstructed. The
website-to-desktop-install boundary remains unlinked: installer delivery is
hosted externally and downloads contain no visitor token. Do not present an
app-open funnel as website-to-install conversion.

### Verification after deployment

1. Verify the same public project key is set for both production site builds.
2. In a production browser without privacy signals, navigate between pages,
   click a download, and open docs. Confirm matching anonymous distinct IDs on
   website and docs events, with the correct `surface` and schema version.
3. Read a docs page for 30 active seconds and scroll halfway; confirm one
   engagement event. Hidden, unfocused, or idle tabs must not accrue reading time.
4. Repeat with DNT/GPC and confirm no SDK initialization or capture.
5. Inspect sanitized payloads for URLs without queries/fragments and no content.
6. Confirm dashboard counts, funnel step ordering, and OS/architecture breakdowns.

### Live audit, 2026-10-04

The connected production project had no `$pageview` events in the preceding
30 days and no website CTA events. It had 175 active app identities, 261 chat
creation events from 64 identities, and 1,208 message submissions from 59
identities. This audit includes all observed app schema versions and is a dated
snapshot, not a live counter. Existing saved dashboards were a starter dashboard
and an app overview; the repository's provisioning definitions had not created
the broader reporting suite in that project.

### Dashboard links

- [Website acquisition](https://us.posthog.com/project/524313/dashboard/2168728)
- [Docs engagement](https://us.posthog.com/project/524313/dashboard/2168729)
- [Desktop usage](https://us.posthog.com/project/524313/dashboard/2168722)

These dashboards were created through the connected PostHog integration on
2026-10-04 with 38 saved insights. Full-period summary tables deduplicate
identities across the entire window instead of adding daily unique counts.
Desktop queries return live data. Website/docs queries await instrumentation
deployment; zero observed events currently means missing coverage, not no visitors.

Local verification covers both production builds, relevant type checks, shared
and website unit tests, desktop payload privacy and outbox migration tests,
docs links, provisioning idempotence, and an isolated real-SDK browser smoke test
for shared cookies, navigation, download clicks, engaged reading, and sanitized
URLs. Synthetic browser traffic was intercepted and never sent to production.
