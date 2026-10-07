# Hosted review control plane and release gates

Zuse Review has hosted scheduling, native-account login, worker dispatch, optional isolated repository checks, GitHub publication and billing integration. It remains disabled for release: the provider eligibility module rejects unverified subscription authorization, native-tool confinement and durable authentication. Deployment flags do not override those requirements. A successful local test is not provider approval or live settlement evidence. Connecting GitHub alone neither enables reviews nor authorizes spending.

## Ownership and durable scheduling

`review-store.ts` persists verified GitHub identity bindings, repository enrollments, signed webhook inbox records, refresh leases, immutable review runs, fenced attempts and publication intents. `review-lifecycle-store.ts` adds dedicated native connections and compute activities. Migration `0039_review_control_plane.sql` and its Drizzle schema are additive. Apply migrations through the normal reviewed deployment process. Review work does not move existing workspace databases or initialize user runtime data.

Routing selects the enabled personal enrollment matching the verified numeric PR-author ID before considering the repository's shared enrollment. Readiness is checked after selection: an expired personal login or insufficient personal budget cannot fall back to shared spending. Runs retain their payer, connection, model, worker configuration, enrollment version and exact base/head comparison. Subsequent configuration changes cannot rewrite financial ownership. Explicit reruns create a new generation; automatic deduplication prevents another charge solely because an enrollment changed.

Existing GitHub HMAC verification precedes durable webhook insertion. The inbox stores normalized identifiers, not PR descriptions or source. Repository leases fence remote GitHub reads and run creation. Current PR state is fetched before routing. Automatic events for the same PR or pushed base ref coalesce under the repository lock: a new delivery postpones unclaimed work by 30 seconds, capped at two minutes from the first delivery. Delivery IDs remain deduplicated, and in-flight leases are not reset. Scheduled reconciliation recovers missed wakeups; actual start time also depends on scheduler availability and queue load.

Draft and bot-authored PRs require explicit requests. Fork PRs require repository-admin approval for their exact head SHA; a changed head needs another approval. A base-branch push refreshes open PRs targeting that branch with bounded pagination. Disabling coverage and recognized installation/repository revocations invalidate work and artifact access. Artifact reads and publication independently recheck repository access. The lifecycle reconciler then stops actual compute; a database cancellation alone does not prove shutdown.

## Authenticated interfaces

Personal and organization account operations reuse WorkOS authentication and workspace authorization. Reads require content access; mutations require administration. Native connections additionally require their credential-owning actor. Worker endpoints use an independent, short-lived attempt-bound boot secret and cannot be called with ordinary enrollment parameters.

| Method and path | Responsibility |
| --- | --- |
| `GET /v1/review/setup` | Authorized repositories, native connection/model choices, eligible worker sizes, price estimates, payer and verified GitHub identity. |
| `GET /v1/review/coverage` | Readiness reasons and caller-owned enrollments. |
| `GET /v1/review/enrollments` | Enrollment metadata for the selected payer. |
| `POST /v1/review/enrollments` | Explicit spending acknowledgment, fresh GitHub permissions, native connection ownership and eligible placement; returns the enrollment directly. |
| `POST /v1/review/enrollments/:id/disable` | Disable owned coverage and cancel outstanding work. |
| `POST /v1/review/connections` | Create dedicated native-login metadata with explicit authentication-compute acknowledgment. |
| `GET /v1/review/connections/:id` | Read or reconcile native login state; never return provider credentials. |
| `POST /v1/review/connections/:id/login` | Reserve authentication compute and start the native provider's hosted login. |
| `POST /v1/review/connections/:id/complete` | Forward a callback matching the pending native login; the native process owns PKCE and token exchange. |
| `POST /v1/review/connections/:id/revoke` | Revoke the actor's native connection and stop its active reviews. |
| `GET /v1/review/runs?cursor=...` | Payer-scoped history metadata without repository-result artifacts. |
| `GET /v1/review/runs/:id` | Run metadata and authorized results, subject to fresh repository access. |
| `POST /v1/review/runs` | Explicit review of an existing PR, including exact-head fork approval when required. |
| `POST /v1/review/runs/:id/retry` | Explicit paid rerun under the selected enrollment; does not inherit another payer's authority. |
| `POST /v1/review/runs/:id/cancel` | Cancel owned work while retaining incurred usage. |
| `GET /v1/review/runs/:id/fix-context` | Authorized findings and current comparison without sponsor credentials, transcripts or billing details. |
| `POST /v1/review/attempts/:id/{bootstrap,heartbeat,result}` | Attempt-bound snapshot bootstrap, lease renewal and durable result submission. |

Enrollment reuses the user's existing authenticated GitHub connection and verifies current repository permissions; it does not require the formerly proposed review-specific OAuth browser bridge. Shared enrollment additionally requires repository administration and control over the payer. Legacy one-use setup-intent persistence does not grant new enrollment or execution by itself.

`GET /review/fix` is a public HTTPS landing containing opaque identifiers only. Desktop deep links and hosted-browser query continuation open the Review pane without starting an agent. The authenticated app rechecks repository access and current PR head. The requester chooses their own workspace and account, attaches selected findings and explicitly starts the fix. A copyable-context fallback remains available after authorization.

## Native execution and repository context

`review-native-connections.ts` manages a dedicated native Claude login sandbox with a private auth home. It reserves and observes authentication compute, verifies the native account fingerprint, pauses successful login compute and reconciles failed, revoked or timed-out activities. Credentials are never copied into chat directories or returned through Review APIs. Codex remains unavailable; there is no API-key substitution for an ineligible subscription profile.

`review-lifecycle.ts` claims a run and verified provider identity, reserves compute, resumes the dedicated sandbox and starts the pinned worker artifact. Connection leases prevent concurrent use; persisted execution intent, provider labels and enforced lifetimes support recovery without blindly starting a replacement. The supervisor confirms shutdown or pause before releasing execution ownership. GitHub write credentials remain in the API control plane. Worker fetch credentials are repository-scoped and are removed before analysis.

The native worker fetches and verifies the exact Git objects and merge base. Repository retrieval uses bounded reads, lexical/symbol indexing and static import relationships. The trusted supervisor, native CLI and repository reader use distinct process responsibilities and Unix identities. Native tools are restricted to the supplied immutable repository service; repository hooks, plugins, shell and arbitrary native tools are disabled or denied. These are implemented controls awaiting hostile-repository confinement evidence, not proof that provider isolation has passed.

The investigator gathers concrete suspected regressions; fresh verifier contexts reconstruct them independently. Trusted code validates locations and quoted evidence before durable acceptance. TypeScript/JavaScript has the strongest symbol/import support; unsupported language or ingestion limits remain visible as partial context or coverage. No complete semantic call graph is claimed.

## Isolated repository checks

`review-check-execution.ts` runs executable checks only after native inference compute is confirmed stopped. A separate ephemeral sandbox receives repository snapshots without the provider auth home or model credentials. Preparation and execution are separate phases: fetch/install credentials are removed and execution egress is denied before untrusted repository commands run. The supervisor owns evidence files and bounded process lifetimes.

The initial runner discovers the base repository's root `test`, `typecheck` and `check-types` scripts and applies the same commands to base and head. Registry-only npm lockfiles and inspectable text Bun lockfiles are supported with install scripts disabled. Unsupported dependency layouts, unavailable commands, installation failures and budget exhaustion produce explicit incomplete check coverage. Workspace dependency installation, pnpm/Yarn and binary Bun lockfiles are not currently supported by this initial runner; do not describe the feature as universal CI execution.

Results distinguish passed, failed, timed out and inconclusive outcomes, with bounded plain-text output for base and head. A passing check does not prove the absence of bugs, and a failure is not automatically attributed to the PR. Check compute shares the run's runtime and monetary limits and retains its own durable activity attribution.

## GitHub publication

`review-publication-live.ts` supplies the scoped GitHub installation transport, live access/approval checks, secret screening and trusted HTTPS fix links. `review-publication.ts` validates the stored snapshot and finding payloads, renders model content as plain text, and posts an advisory check plus at most five inline comments. Additional verified findings appear in the bounded check summary; larger output links to the full authorized result. Executable-check status is disclosed separately from review findings.

The outbox has no access to paid analysis. A known failure before any write restores creation permission; an ambiguous POST response requires reconciliation using owned App/bot markers and stable publication identities. Existing findings update the bot's own comment without deleting human discussion. Raw content is screened before Markdown escaping, then rendered output is screened again. Freshness is checked before and after writes; a superseded result retains the remote GitHub ID when available. Three unresolved ambiguous reconciliations block the run for intervention rather than blindly creating duplicates.

Publication requires its own `publicationEnabled` flag in addition to provider and staging readiness. Turning it off leaves validated results and financial reconciliation intact. No required merge check, automatic approval or merge operation is configured.

## Compute and billing

`review-pricing.ts` resolves provider/size rates, validates price-window coverage and atomically reserves against the same account budget used by other cloud workloads. Per-review monetary limits and displayed compute values include the billing period markup before plan allowances; actual invoice overage can be lower. Existing account reservations retain provider-cost units so the shared billing policy applies markup once. The aggregate allocated runtime covers provisioning, analysis, retries and repository checks; queue time has no allocated-worker charge. Attempt count is bounded to two. Authentication is a separately acknowledged, attributable compute activity.

All attributable allocated compute remains chargeable, including failed, canceled and superseded work. Runtime observations flow into the existing usage ledger and Polar export machinery. `review-billing-attribution.ts` matches provider execution windows to durable attempt/activity records, including reused paused sandboxes; it never assigns historical usage to whichever account currently owns a connection. Unknown or ambiguous evidence remains a reconciliation condition. Estimates are not final settlement.

Only E2B placements are implemented for this hosted profile. The new general Boxd usage integration does not enable a Review execution profile; review-specific persistence, confinement and settlement evidence are still required. Reservations, delayed provider evidence and usage export still require live staging verification with actual provider and Polar records.

## Release and verification

The release prerequisites are provider approval for this exact hosted/subscription/shared-coverage use case, hostile-repository confinement and durable-auth evidence for the pinned profile/image, deployment of the tested images, and live staging through GitHub publication, shutdown, provider evidence, ledger and Polar. `getReviewProviderEligibility` deliberately returns blocking reasons until evidence is recorded in reviewed code. Deployment enablement and `stagingVerified` cannot bypass that provider gate. Rollback disables admissions/publication, stops workers, and keeps settlement/reconciliation operating.

Local validation includes Biome, TypeScript/architecture checks, unit tests, actual PostgreSQL tests in an isolated database, and renderer/browser handoff fixtures. Coverage includes author-over-shared routing, immutable payer provenance, leases and stale results, cancellation/recovery, native-login state handling, pre-write versus ambiguous publication recovery, approved forks, secret screening, superseded remote provenance and narrow-window UI. Transport fixtures are not live subscription, GitHub or billing evidence; behavioral test results are recorded separately in implementation status.

Run `bun run --filter @zuse/api check-types`, `bun run --filter @zuse/api test:unit`, and `bun run --filter @zuse/api test:integration`. PostgreSQL suites use `ZUSE_TEST_POSTGRES_URL` and `ZUSE_TEST_DATABASE_URL`; point both at an isolated test database. Run `CHROME_PATH=/usr/bin/google-chrome bun run --cwd apps/renderer test:review-browser` for the authenticated-boundary UI fixture. No local verification claims the human-adjudicated precision/recall gates have passed.
