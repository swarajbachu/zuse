# Cloud agent search rollout

## Content ownership

The English homepage targets the product query “open source cloud agents.”
`/blog/open-source-cloud-agents` answers the informational query and links to
setup, parallel work, authentication, costs, and review guides. Supporting
articles answer distinct questions rather than repeating the same headline.

Published-source evidence for the release overview and recovery journal:
https://github.com/swarajbachu/zuse/releases/tag/v0.21.0 (published September 5,
2026; verified September 24). The articles are dated when written, not backdated
to the release. Cloud remains a public beta; mobile requires compatible services
and images. The engineering journal proposes checks and does not claim to have
performed them.

## Deployment

The website uses the app's PostHog project. At build time it reads
`NEXT_PUBLIC_POSTHOG_KEY`, then `VITE_POSTHOG_KEY`, then `ZUSE_POSTHOG_KEY`.
The host uses the corresponding public host variables in the same precedence,
with the US ingest host as the default. Keep the host and key in the same region.
Provide these variables to the website deployment as well as desktop releases;
GitHub release secrets are not automatically available to the web host. Never
expose a personal PostHog API key. A missing public key disables collection.

All website events have `surface=website`. Initial pageviews and client-side
navigation use `$pageview`; download and pricing links send
`website_cta_clicked` with a path-only `destination`. Replay, autocapture,
persistent analytics storage, and person profiles are disabled. Do Not Track and
Global Privacy Control disable startup. URL query strings and fragments are
removed; referrers retain their origin only. Temporary memory means visitor
counts across reloads are not reliable unique-person counts.

After deployment, confirm a pageview and a CTA event arrive in the existing
project, filtered by `surface=website`. Test client navigation, a full reload,
and privacy signals. Local tests and a build do not prove hosted ingestion.

## Search verification and measurement

The live sitemap already existed at `/sitemap.xml` on September 24. The changes
add its footer link and maintain real editorial update dates for revised posts.
All blog entries come from the content collection. Robots.txt advertises it.

After deployment, submit the sitemap in the verified Google Search Console
property and inspect the homepage, main guide, and new article URLs. Confirm
Google's selected canonical matches the intended canonical. The public apex
currently redirects to www; verify hosting and canonical configuration together
before changing the site's configured origin.

Record a baseline and compare at 14 and 28 days: impressions, clicks, CTR, and
average position for the exact query and related cloud-coding queries, split by
landing page. In PostHog compare referring domains, article pageviews, and
website CTA clicks. PostHog cannot provide Google keyword rankings or replace
Search Console. No automated monitoring or external dashboard is provisioned
by this change.

Next editorial candidates: a reproducible first-cloud-task walkthrough, a
worked parallel-branch integration example, and the next verified release
summary. Publish only with evidence and a distinct reader question. Refresh
existing guides when behavior changes; do not manufacture freshness dates.
