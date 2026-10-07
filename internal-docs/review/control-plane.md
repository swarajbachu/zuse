# Review control plane: implemented foundation and launch gates

The review control plane is wired into the API Worker, but hosted review is unavailable. No configuration flag can bypass its readiness checks. Existing GitHub connections do not enable review or authorize spending.

## Implemented boundaries

`infra/api/src/review-store.ts` provides PostgreSQL persistence for verified GitHub identity bindings, one-use setup intents, repository enrollments, signed webhook inbox records, repository refresh fences, immutable runs, attempt attribution and publication intents. Migration `0039_review_control_plane.sql` adds these tables; the Drizzle schema and migration journal include them. Apply through the normal reviewed migration process before deploying the Worker. This implementation does not change runtime SQLite, user-data paths, or existing sandbox recovery.

Routing selects an enabled personal enrollment matching the numeric PR-author ID, otherwise the repository's single enabled shared enrollment, otherwise nothing. Selection precedes readiness checks. A blocked personal connection cannot spend shared funds. The selected payer, connection, worker settings and comparison are persisted. Automatic comparison identity includes repository ID, PR, base ref, base SHA, head SHA and policy version. Explicit manual generations are supported by the store; their HTTP execution remains gated. Changing enrollment does not retroactively change run ownership.

Repository refresh leases fence GitHub reads before run creation. The store verifies the unexpired token inside the same repository lock used for enrollment changes. Delayed responses from a previous refresh cannot supersede newer work. The webhook inbox persists only normalized identifiers, not PR text or source. Existing HMAC verification runs first. Current PR state is read from GitHub before routing. Draft and non-human authors are skipped; fork runs are blocked pending a still-unimplemented head-specific maintainer approval flow. Base branch pushes refresh open PRs on that branch; pagination is bounded. Events have a fixed 30-second eligibility delay. Full coalescing and maximum-delay scheduling remain unfinished.

Disabling enrollment increments its version, cancels queued/active run state, invalidates result/claim acceptance and cancels pending publication. Installation deletion, suspension and repository removal conservatively disable its review enrollments. Financial attribution remains available. Attempt records are primitives: no running sandbox is actually created or stopped by this change. A future dispatcher must observe cancellation, revoke grants and confirm shutdown; setting a run to cancelled alone is not evidence that compute stopped.

## HTTP surface

All `/v1/review/` requests use existing personal/organization WorkOS authorization. Organization access still depends on the existing organization-workspaces feature. Read operations use content access; mutations require administration.

| Method and path | Current behavior |
| --- | --- |
| `GET /v1/review/coverage` | Readiness reasons and caller-owned enrollments; always unavailable until all launch gates are implemented. |
| `GET /v1/review/enrollments` | Caller-owned enrollment metadata. |
| `POST /v1/review/enrollments` | Validates request, then rejects unverified readiness before initiating credentials or OAuth. Future success returns an authorization URL. |
| `POST /v1/review/enrollments/:id/disable` | Disables owned enrollment and invalidates its active work. |
| `GET /v1/review/runs?cursor=...` | Owner-scoped, paginated history metadata; excludes result artifacts. |
| `GET /v1/review/runs/:id` | Owner-scoped metadata; results require active enrollment and fresh GitHub repository access. |
| `POST /v1/review/runs` and `POST /v1/review/runs/:id/retry` | Explicitly unavailable until execution and spend authorization are implemented. |
| `POST /v1/review/runs/:id/cancel` | Cancels owned work without rerouting its payer; returns metadata only. |
| `GET /v1/review/runs/:id/fix-context` | Requires active enrollment and current repository access. Returns findings/comparison only, excluding sponsor, connection, transcript and billing details. |

Artifact access after enrollment revocation is denied independently of launch readiness. Private-repository checks resolve the verified GitHub numeric identity to its current login and query collaborator permission. GitHub documents the returned legacy permission values as `admin`, `write`, `read`, `none`; custom roles map to these base permissions. See [GitHub repository permissions API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user). Public repository content still requires a verified Zuse-linked GitHub identity for this surface.

## Setup and publication seams

`review-github.ts` implements one-use setup intent verification, OAuth nonce cookie handling, fresh GitHub user/repository permission verification and repository-scoped installation-token verification. Shared setup requires repository admin permission. Identity linkage rejects implicit transfer between GitHub users. OAuth credentials are not persisted.

A matching authenticated WorkOS browser actor is required before the callback can link identity. Normal external-browser navigation cannot supply the desktop's bearer header. An authenticated browser bridge is intentionally unfinished; the code does not weaken this check or accept a callback merely because someone visited an authorization URL.

`review-publication.ts` implements transport-injected, schema-validated GitHub publication. Summary and up to five inline finding intents receive separate durable IDs. Claims persist an uncertain state before network writes. Retry claims cannot create blindly after response loss; they reconcile own-App markers. Existing finding discussions can be updated using stable IDs, with original anchor and newly reviewed location clearly distinguished. The publisher checks exact comparison freshness before and after writes and requires trusted output screening and HTTPS fix links.

`ReviewPublicationGateway` has no live layer. The scheduled drainer is wired but gated before claiming outbox rows. Three unsuccessful uncertainty reconciliations block the run with `review_publication_ambiguous`, preserving evidence for intervention. Cancellation/staleness must not be presented as a completed clean review. Live repository-scoped write transport, screening and operational intervention are still launch requirements.

## Compute and billing limits

Billing changes add the `review` resource kind to usage/ledger interfaces and an immutable review-attempt owner lookup to provider settlement. E2B evidence includes its sandbox ID and must match the recorded review sandbox. This is attribution plumbing, not a finished billing product or proven Polar delivery.

Attempt persistence bounds count to two, serializes unfinished attempts, checks the enrolled provider and aggregate enrolled runtime ceiling, and retains provider/sandbox/owner attribution after cancellation. Native allocation, actual lifetime enforcement, credential enrollment, heartbeat/recovery, orphan cleanup, trusted execution, atomic account/dollar reservations, observation emission and final shutdown are not implemented by these primitives. Existing placement eligibility, ledger and usage outbox must be reused. Boxd must remain excluded without settlement evidence. Estimated runtime must never become confirmed charges.

`review-readiness.ts` keeps infrastructure blocked independently of provider feasibility. Its blockers identify the authenticated-browser bridge, native dispatcher, compute reservations and publication transport. `@zuse/agents/review/eligibility` separately blocks unverified hosted subscription authorization, native tool confinement and native authentication. These are code prerequisites, not environment switches.

## Verification

Validation uses Biome, the API TypeScript check, API unit tests and actual PostgreSQL integration tests in an isolated local database. The review test covers concurrent routing and claims, author precedence without spend fallback, revoked ownership, immutable payer attribution, manual-generation storage semantics, exact-SHA result fencing, restart recovery, unknown publication outcomes, repository refresh fencing and artifact revocation. Publisher tests use injected transports and perform no external writes.

Run `bun run --filter @zuse/api check-types`, `bun run --filter @zuse/api test:unit`, and `bun run --filter @zuse/api test:integration`. PostgreSQL tests use both `ZUSE_TEST_POSTGRES_URL` and `ZUSE_TEST_DATABASE_URL` conventions already present in the repository; point both at an isolated test database. No external migrations, paid workers, provider logins, GitHub comments, Polar exports or deployments were performed. Production-to-provider-to-ledger-to-Polar verification remains a launch prerequisite.
