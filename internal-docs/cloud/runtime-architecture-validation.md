# Runtime reliability and latency validation plan

Status: validation contract with a historical local baseline, implementation results and live provider follow-up below. The initial implementation pass used local fixtures; the subsequent authorized live checks used disposable provider resources and read-only database reference audits.

Baseline inspected on 2026-10-10 at approximately 07:03 UTC. Repository HEAD: `16c31d6647887ff5d7996f97bee9776cc30d43bd`, plus the current uncommitted changes. A passing local baseline is evidence for the tested boundaries, not proof that the proposed architecture exists or that live providers meet the latency target.

## Acceptance contract

The same lifecycle and recovery guarantees must hold for Boxd (`boxd`), Boat/legacy Box (`box`), and E2B (`e2b`). Provider adapters may implement different primitives; unsupported observations must remain explicit rather than being interpreted as process death.

1. At most one runtime process owns the authoritative database writer and enrollment authority. A lost gateway, HTTP timeout, missing callback, absent capability, or unknown process observation cannot authorize replacement.
2. Existing workspace, sandbox, image generation, chat, session, repository changes, provider session state, and storage incarnation survive pause, wake, reconnect, compatible runtime update, and rollback. Only an explicit deletion or separately authorized fork changes the relevant identities.
3. Each accepted command retains its original command/turn/message identity. Proven committed work is acknowledged again, never applied again. An unprovable external side effect becomes an explicit uncertain outcome; local receipt deduplication is not a universal exactly-once guarantee for third-party tools.
4. Execution generation and gateway epoch move only through their owning authority. Delayed events from an older generation cannot recover authority or undo a newer lifecycle decision.
5. Runtime update preparation does not stop or fence the current runtime. Activation occurs only after a durable authorization change and successful stopped-writer handoff. Signed previous release and transaction journal survive interruption. Completion requires the exact transaction, runtime version, generation, and authenticated recovery evidence.
6. Renewal, revocation, account membership failure, provider authentication failure, RPC schema mismatch, transport failure, runtime absence, and storage loss remain distinguishable. Client reconnection must not allocate or replace compute implicitly.
7. Every operation has either terminal evidence or an explicitly armed durable continuation. Successful scheduling, provider launch acknowledgement, local `/healthz`, and successful return from a short observation loop are not completion.
8. Boxd new workspaces and wake must become usable on the original chat, with the selected agent able to execute the accepted command, in under five seconds from user action. A durable receipt queued before agent credentials, checkout or session recovery are ready does not pass. Every attempt over five seconds is a target miss; p50/p95/p99 are diagnostic summaries, not a weaker acceptance goal. Account/image prerequisites, legacy migration and degraded-provider cohorts disclose the full user wait and misses, even when reported separately. The canonical contract and allocations are in [architecture plan](runtime-architecture-plan.md).

Read `internal-docs/cloud/runtime-data-recovery.md` and ADR 0002 before any real retained-data experiment. Never use a production workspace as the fixture.

## Executed baseline and its limits

The root invocation initially could not import two client suites because it lacked their workspace `~` aliases. Both were rerun with their real workspace configs; these were test invocation errors, not failed behavior assertions. The successful root run cases and successful workspace reruns must be deduplicated when counting results.

| Area | Baseline cases | Scope actually exercised |
| --- | ---: | --- |
| API unit tests | 810 passing | 80 files, including activation orchestration, startup scheduling, gateway, mailbox, bootstrap/renewal, store, and provider policy |
| Sandbox provider unit tests | 243 passing | Six files; mocked API/SDK adapters plus real local process/shell checks |
| Selected server runtime tests | 113 passing | Updater, asset integration assertions, workspace runtime, provider auth, and delegated auth |
| Shared client-runtime unit tests | 317 passing | 34 files including runtime ownership, reconnect, outbox, command dispatch, timeline and subscription drivers |
| Selected renderer account/RPC/SSH/timeline tests | 89 passing | Five files, with renderer aliases/config |
| Selected mobile runtime/bus/connection tests | 29 passing | Four files: explicit wake, account fencing, passive discovery, lost responses, attachment failure, bus lifetime and connection errors |

These selections total **1,601 distinct passing cases across 134 files**. Logs and JSON reports are under `/tmp/runtime-architecture-{baseline,renderer,mobile,timeline,mobile-bus}.{log,json}` for this session; `/tmp` is not durable release evidence.

Specific passing evidence in the current tree:

- `infra/api/test/unit/cloud-workspace-runtime-activation.test.ts`: 11 cases prove preparation retains old generation/credential; prepared activation allocates a fresh fence with sealed boot material; pre-enrollment response loss replays one operation; enrollment receipts before and after ACK prevent spent-token replay; ACK removing token expiry does not cause a false timeout; signed rollback clears the old receipt and fences freshly; authenticated session-head recovery gates confirmation; confirmation matches generation and version.
- `apps/server/test/unit/cloud-runtime-updater.test.ts`: signed real archives and separate updater processes, SIGKILL before/after symlink activation and during rollback, stale generation rejection, fresh rollback retry, corrupt journal rejection, failed staging preserving current, legacy image baseline adoption, and refusal of unproven signed rollback. These use isolated temporary directories, not a live workspace database.
- `infra/api/test/unit/cloud-workspace-resume-script.test.ts`: real two-process contention prevents the second installer/runtime from entering; inherited lock survives exec and is released at owner exit; installer and repository failures retain phase/exit diagnostics. A rejected contender does not poison the live owner's shared failure marker.
- `packages/sandbox-providers/test/unit/box-process.test.ts`: persistent owner intent, same-operation launch replay, older/conflicting generation denial before stop, fork ownership reset, and denial while a copied updater or SQLite writer still exists. Systemd behavior is simulated; this is not live systemd/provider conformance proof.
- `infra/api/test/unit/cloud-workspace-reconciler.test.ts`: confirmed process absence is required after warm reconnect grace; active/unknown/missing/failed observation preserves generation, credentials and sandbox. This does not prove the observation implementation is correct on every live provider.
- Bootstrap/runtime tests cover long-sleep renewal, key and generation binding, response-loss bootstrap receipts, revocation, 401 classification, renewal outages, durable command receipts, late ACKs, and retained-session readiness. They do not run a multi-day provider sleep or a full fleet migration.
- Gateway tests cover generation fencing, peer replacement, legacy envelope translation, client detachment and backpressure. Real Durable Object eviction, deployed code replacement, and complete end-to-end RPC resubscription remain separate work.
- Startup tests prove atomic scheduling acknowledgement, failed transaction handling, alarm retry renewal, and preservation of a newer wake while older work runs. Their mocked reconciler resolving does not prove that a real lifecycle operation reached completion.

## Current gaps that the next design must close

| Gap in inspected working tree | Required new failing test before implementation |
| --- | --- |
| Transactional restart is gated by `supportsFencedProcessReplacement` plus installer/manifest config; only `boxd.ts` currently advertises the capability. Boat and E2B still use their legacy paths. | Run one provider-neutral update/recovery contract against all three adapters; no provider silently bypasses prepare/fence/stop/activate/confirm semantics. Capability absence gives an explicit unsupported/recovery-needed result while preserving the writer. |
| `reconcileRuntimeActivation` returns from the healthy-summary branch and `confirming` branch before its timeout check. Backoff limits retry frequency, not total pending duration. | Lose every confirm ACK; remove matching summary; crash runtime during confirming. Each reaches a bounded explicit outcome or a durably visible verification-needed state. A healthy current runtime must not be falsely killed or declared unhealthy merely because a journal ACK was lost. |
| `WorkspaceStartupTask.alarm` removes `pending` after its callback resolves. The real `reconcileCloudWorkspaceStartup` may resolve after the approximately 22.25-second observation budget or because its readiness predicate no longer includes active preparation/confirmation. | Real coordinator + real reconciler + persistent fake store test: preparation lasts longer than the observer budget; after callback return, a durable alarm/owner must still exist until terminal operation evidence. Recreate the coordinator and prove completion without a new client request or the minute cron accidentally rescuing it. |
| Old installed releases lack retained signed manifests, and publication overwrites `stable-manifest.json`. | A legacy populated workspace either establishes verifiable rollback provenance before unsafe handoff or follows the documented non-automatic migration path. Never relabel unsigned bytes as a signed rollback or strand an unconfirmed operation behind a new UUID. |
| Current exact-version confirmation checks journal/current-release evidence plus authenticated generation/session head; runtime summaries do not currently carry a runtime version. | Demonstrate that the authenticated process corresponds to the signed activated release. If the new design adds reported version evidence, test stale/mismatched reports and bind it to the current credential and generation. |
| Provider process observations and fencing implementations are asymmetric; a warm runtime can remain active while its gateway is unavailable. | Live adapter conformance distinguishes active/inactive/unknown and never treats an observation transport error as stopped-writer proof. A bounded unavailable state preserves the healthy owner's authority. |
| Existing `box-resume-benchmark.ts` measures a no-account server health endpoint via provider commands. | A separate product-path Boxd latency experiment measures real enrollment/renewal, attachment and selected-agent execution readiness without a diagnostic exec waking the machine. Do not publish its old health metric as chat recovery latency. |

## Shared fixture and independent oracles

Create one test fixture builder used by all provider scenarios. Preserve fixture expectations outside the guest being tested so a recreated sandbox cannot produce its own passing oracle.

Record: provider sandbox ID, image generation, workspace ID, chat ID, session ID, storage incarnation, runtime generation, gateway epoch, operation ID, command ID, turn ID, message ID, original account actor, expected receipt digest, expected session-head version, and expected repository commit plus uncommitted patch hashes. Use fake secrets; never record bearer tokens, private JWKs, or provider credentials.

Populate the runtime with:

- An existing chat/session and a queued command, a committed command whose ACK will be dropped, and a command with a deliberately ambiguous external effect.
- A SQLite database with a committed row still in WAL, unrelated rows and indexes, provider-native session files, and a changed repository file. Keep the fixture writer stopped for filesystem backup comparisons; for live backup use SQLite's backup mechanism. Never copy only an active `.sqlite` file.
- A stable storage-incarnation marker and a separately retained expected-ID manifest. Include empty-path decoys and two distinct populated paths; ambiguous authoritative storage must stop automatic initialization.
- Current and previous signed runtime artifacts, a corrupt artifact, an incompatible protocol artifact, and a legacy unsigned installed directory. Use an ephemeral signing key held by the fixture process.

Oracles after each injected fault:

1. SQLite read-only integrity check and expected chat/session/command/turn rows, including the WAL-backed committed row. Compare logical content/receipt identities rather than expecting byte-identical databases after legitimate activity.
2. OS-level writer ownership and a guest lock probe, plus API credential-generation checks. A provider's `active` string alone is not proof of exactly one writer.
3. Agent-side invocation counter and durable receipt table: known work has one logical apply; lost ACK returns the same receipt. The ambiguous external-effect case is visibly unresolved and is not silently resent.
4. Same sandbox/image/storage IDs, unchanged repository edits and provider-session files. Rollback changes executable selection, not user data.
5. Every accepted wake/update/command has an operation record and either a terminal event or a persisted next due time. Every terminal failure has a stable code and bounded, redacted diagnostic.
6. Client observation confirms the original session advances. Green provider state or `/healthz` cannot satisfy this oracle.

## Provider conformance matrix

A future shared `provider-runtime-conformance` suite should parameterize the provider adapter and use these semantic checks. Keep provider-specific HTTP/systemd/envd fixtures in adapters; keep lifecycle expectations in one suite.

| Contract case | Required observation |
| --- | --- |
| Create response lost before/after provider allocation | Same deterministic operation finds/adopts exactly its allocation; no second sandbox. Existing retained data never enters fresh-allocation fallback. |
| Concurrent create/wake/restart for one workspace | One durable owner; losing claimant waits or observes the same result. Different workspaces remain independent. |
| Pause/resume with runtime memory preserved | Same process authority/generation/credential remains valid or renews; no updater, Git fetch, image rebuild, or replacement just because the gateway reconnects. |
| Process-preserving provider loses tags | Probe includes narrow legacy processes; a still-running writer is not mistaken for absence. |
| Inactive process, successful stopped-writer proof | Exactly one fresh fenced launch; old auth rejected; new authenticated process reaches retained-session readiness. |
| Active, unknown, missing probe, or transient probe error | No generation advance, stop, kill, or allocation. Retry/diagnostic has a bounded policy independent of transport retries. |
| Launch response lost / shell never starts / shell exits | Durable operation distinguishes delivery acknowledgement, actual process start, and authenticated readiness. Same operation retries only before enrollment; a bound/consumed token never boots a new key pair. |
| Out-of-order generation operations | Older and conflicting owner requests fail before stopping the current process. A new generation never inherits another operation's auth. |
| Provider says absent / permission denied / timeout / malformed response | Only authoritative absence is absence. For retained workspaces even confirmed absence produces explicit storage-loss handling, not a hidden replacement chat. |
| Provider host wakes before disk aliases are ready | Shared readiness barrier preserves the original data path. Initialization cannot race mount restoration. |
| Quarantined native fork | Child retires copied writers and copied lifecycle authority before unquarantine; parent continues untouched; child gets explicit new identities while imported source provenance remains recorded. |
| Pause/archive/delete arrives during prepare or launch | Durable desired-state fence wins. Delayed launch, receipt, or callback cannot resurrect execution. Cancellation after command application reports its actual outcome. |

Run the same contract against (a) deterministic adapter fakes with injected failures, (b) local real-process fixtures, and finally (c) explicitly authorized disposable provider resources. A provider lacking the primitive cannot pass by skipping a safety assertion.

## Fault injection at every durable boundary

For each cut below run: fail before the write; commit then lose the response; kill the process after the write; restart the coordinator; retry the same request; race a newer authorized operation; deliver the older response last. Seeded deterministic schedules must be reproducible. Start with all pairwise interleavings, then randomized long sequences; retain the seed and minimal failing event trace.

| Cut | Required post-recovery result |
| --- | --- |
| Client outbox persisted / wake submitted / API acceptance returned | Same wake/command ID after crash; passive attachment does not manufacture new demand. |
| DO pending write / alarm commit / 202 response | No acknowledgement before both durable writes. Lost 202 is idempotent. Eviction retains pending work. |
| Prepare download / signature / checksum / extraction / release rename | Previous release and live credentials remain usable. Bad bytes never become current. Partial staging can be retried without overwriting retained data. |
| Prepared journal commit / API reads journal | Another operation cannot adopt a non-null-generation pending update. Narrow legacy image baseline adoption does not imply confirmation. |
| Generation fence and sealed boot persisted | Delayed old owner cannot publish/lease as current. Crash recovery has one durable next action, not just an expired token. |
| Old process stopped / lifetime lock acquired | No activation while an unaccounted writer exists. Contender failure has its own attempt evidence and does not poison the live owner's readiness files. |
| Activating intent / symlink rename / activated journal | Idempotent retry converges to the journaled candidate; previous signed target remains recoverable. |
| Process acknowledged / first shell phase / exec | Differentiate lost provider response from no process, failed installer and failed exec. Diagnostics identify generation and phase without credentials. |
| Bootstrap receipt written / bootstrap response lost | Same-process same-key replay yields identical credential response; new key pair cannot reuse its authorization. |
| Bootstrap ACK / boot token removal | A missing token expiry is consumed authorization, not timeout. Restarts require a fresh fence/token. |
| Runtime summary / ready callback / confirmation command | Original session head and generation required. Lost or mismatched version/generation confirmation never completes the transaction. |
| Healthy process, lost confirmation journal ACK forever | Keep serving the healthy process; bounded operation result explains unfinished verification. Do not spin forever or roll back solely because a response was lost. |
| Rollback fresh fence / previous-pointer swap / rollback enrollment | Previous compatible signed executable under fresh auth; old receipt removed; same data, session and command identities; interrupted rollback can rebind monotonically. |
| Local command receipt commit / API ACK | Retry returns the original receipt and does not run the provider workflow twice. |
| Renewal response persisted / old credential retired | Lost response, response reordering and concurrent renewal remain bounded and identity-safe. |
| Pause/delete committed / delayed launcher finishes | Tombstone or desired-state authority defeats resurrection, including after DO eviction or worker deployment. |

Real process tests should inject SIGKILL at named fixture barriers instead of depending on sleeps. SQLite fixtures must exercise commit and WAL recovery, not replace the database with a JSON counter.

## Authentication, transport, and RPC scenarios

| Scenario | Required behavior and evidence |
| --- | --- |
| Access credential expires during ordinary use or multi-day sleep | Signed renewal keeps the process generation; concurrent callers single-flight; gateway reconnect uses the new credential. Test just before/at/after expiry and with bounded clock skew. |
| Renewal service unavailable longer than access lifetime | Preserve identity and data; report reconnecting/unavailable; retry according to policy without accumulating permanent-auth rejection counts across successes. |
| 401 from expired runtime access / stale epoch / revoked receipt / removed organization member / provider credential | Typed classification selects renewal, passive ticket refresh, permanent authority loss, or provider-login UI respectively. A generic 401 must not trigger blanket runtime replacement or reuse of a boot token. |
| Signed renewal response lost; refresh rotation races two clients | Replay is bound to the same request/identity; old-generation or wrong-key proof never works; no plaintext auth retained in lifecycle records. |
| Account A→B→A, logout, membership removal during handshake | Late ticket, RPC registration and stream responses are discarded using initiating account plus generation; one close/release; no cross-account cache or token reuse. |
| Gateway close before handshake, after healthy connection, during upgrade or deployment | Connection ownership retries the transport; lifecycle ownership is untouched. New ticket fetched when needed; old socket callbacks cannot evict the new runtime/client. |
| DO hibernation with attached peers; object reconstructed from attachments | Correct generation and peer identity restored; old attachments rejected; no unbounded frame buffer; resume works after real object reconstruction. Unit tests of one object instance are insufficient. |
| Server/desktop/mobile mixed versions | Explicit envelope bridge where supported; RPC schema incompatibility surfaced separately; supported previous runtime stays usable. Never infer data loss from a protocol mismatch. |
| Subscription disconnect during snapshot, delta, page request or terminal replay | Resubscribe once with the correct cursor/version; gap detection requests bounded resync; duplicate delta ignored; stale pages dropped; shared consumers keep one live stream. |
| Server sends no handshake or response forever | Opening and pending requests terminate or expose bounded retry state; terminal failures settle all consumers and remove timers/listeners. |
| Client closes during command send / cancel races lease / ACK lost | Durable outbox retains identity; cancellation never claims already-applied work was undone; receipt reconciliation decides outcome. |
| Repeated socket/HTTP failures under load | One retry owner per environment; bounded pending bytes, frames, requests and listeners; retry storms cannot amplify into create/wake/restart storms. |

Exercise the real renderer/mobile bus and shared runtime together with a local RPC/gateway fixture, not only independent mocks of each layer. Add a local Worker/DO emulator test for hibernation/deployment behavior; a new harness/dependency is still required for that coverage.

## Durable scheduling must reach actual completion

Use the real scheduling class, real reconciliation code, memory and disposable PostgreSQL stores, and a controllable provider fixture in one integration test. The durable owner may yield, but it may not erase its pending record merely because a bounded observer returned.

Required scenarios:

- Preparation exceeds the short observation budget, then succeeds without another HTTP request. The next alarm remains persisted; activation, readiness and exact confirmation complete.
- Runtime becomes ready while confirmation is still pending. Ready/heartbeat/summary callbacks cannot move the operation's due time to an idle deadline.
- Reconciler claim is held elsewhere, provider call times out, DB becomes unavailable, or automatic alarm retries are exhausted. Work remains durably scheduled with bounded backoff; recover after outage without manual wake.
- Evict/recreate the DO after each alarm transaction and after successful provider side effects. A newer requested revision is never cleared by an older completion.
- Revoke/delete during a long operation. The durable owner terminalizes it without restarting or allocating resources.
- Start succeeds but summary/confirmation never arrives. Expose the correct bounded failure or verification-needed result; preserve healthy execution when it is independently proven.

The future owner-completion test must assert terminal state or a persisted continuation directly. Do not count a 202, resolved `Promise<void>`, a queued alarm, or cron eventually running as the success oracle. The existing PostgreSQL activation-deadline test covers callback scheduling, not this entire loop.

## Boxd latency experiment

This is a future live experiment, not an executed benchmark. Existing tests did not establish a five-second result.

**End-to-end definition:** start a monotonic timer at the user create/wake action, before dispatch and durable command submission. Stop only when the original chat/requested resource is usable and the selected agent can execute the accepted command: its credential/grant, repository, original session and transport are ready. Require an execution-ready receipt bound to the command and generation, plus a fixture probe that actually enters the selected agent execution path; an earlier mailbox/runtime queue receipt alone cannot stop the timer. Record API acceptance, queue receipt, execution-ready receipt, first actual agent execution, first session progress and first model token separately. Model-token latency is not a runtime-startup proxy. Every sample at or beyond five seconds misses the under-five-second contract.

**Cohorts, reported separately:**

| Cohort | Preconditions | Target interpretation |
| --- | --- | --- |
| Already-running control | Current healthy runtime and fresh client ticket | Baseline client/API/gateway overhead; no lifecycle action expected |
| Preserved wake, valid auth | Confirmed hibernation, populated original session, valid renewal/access state | Boxd <5 s through actual selected-agent execution readiness on the original chat; no generation change or replacement |
| Preserved wake, expired access | Same saved runtime identity, access expired but renewal authority valid | Same target; explicit auth-renewal stage measured |
| New compute from ready image | Published compatible account image; no existing workspace; normal project configuration | Boxd <5 s including provider allocation, disk readiness, runtime startup, auth, repository and selected-agent readiness, original chat catch-up, gateway and execution-ready receipt |
| Runtime update or older snapshot | Retained populated workspace requiring signed compatible update | Reliability/rollback gate first; report full wait and every >5 s target miss in the legacy/update cohort |
| Cold image/build or interactive auth | No ready image or user interaction required | Explicit prerequisite state; if create/wake triggers repair, report full user wait and every >5 s target miss as well as the separate cohort |
| Recovery faults | Delayed provider, network loss, missing mount, lost ACK, revoked auth | Bounded correct outcome and data invariants, not a fabricated sub-five-second success |

**No observer-induced wake:**

1. Install the test workload, instrumentation and non-sensitive sentinel before pausing. Let automatic hibernation occur or explicitly pause via the product operation under test.
2. Confirm hibernation using a verified non-waking control-plane observation. Do not run diagnostic exec, read a guest file, curl guest health, or poll a guest port before T0. Record all provider calls; any unexpected guest interaction invalidates the wake sample.
3. At T0 issue only the product's explicit demand. If the production path itself runs guest readiness/launch commands, include their latency and count; do not call additional diagnostic commands in parallel.
4. Collect timestamped guest evidence only after the execution-ready endpoint (or after the attempt's terminal timeout). A timeout remains a recorded failed sample even if diagnostics subsequently wake it.
5. Do not use the existing health-polling Box benchmark as this measurement. Its helper commands and no-account server omit auth/session recovery and can affect wake state.

Use one trace ID plus operation/command/generation IDs. Record spans for client dispatch, durable outbox, API acceptance, DO pending/alarm commit, alarm dispatch delay, reconcile lease, provider create/wake, disk readiness, preparation when applicable, stop/lock/exec, bootstrap or renewal, retained-session verification, repository readiness, gateway attach, RPC handshake/resubscribe, queue receipt commit, selected-agent execution readiness, actual execution entry and client execution-ready receipt delivery. Use monotonic duration within each process; do not subtract unrelated wall clocks without recording synchronization uncertainty.

Use the canonical budget in [architecture plan](runtime-architecture-plan.md) as the only allocation source:

| Stage | Existing workspace wake | New prepared workspace |
| --- | ---: | ---: |
| Account authorization, durable intent and dispatch | 300 ms | 300 ms |
| Native wake, or create plus idle cap | 500 ms | 500 ms |
| Prepared activation acknowledgment | Not needed | 500 ms |
| Existing runtime reattach, or fresh process/enrollment | 700 ms | 1,500 ms |
| Selected grant, checkout and client ticket in parallel | 700 ms envelope | 1,000 ms envelope |
| Requested-resource catch-up and execution-ready receipt | 300 ms | 300 ms |
| Tail headroom | 2,500 ms | 900 ms |
| End to end | 5,000 ms | 5,000 ms |

These allocations are not measured provider capabilities. Use actual critical paths without double-counting overlapping spans. Cached tabs have a separate requested-resource-usable target under 500 ms, with immediate cached history. A sequential path exceeding five seconds cannot pass by renaming its readiness milestone.

Run a small cost-bounded pilot first, then at least 100 samples per ordinary cohort on dedicated disposable resources within the implementation/validation scope. Randomize cohort/order, include repeated auto-hibernation cycles, and separate low concurrency from representative parallel load (for example 1, 5 and 10 different workspaces). Keep machine size, provider region, image/runtime version, client distance and project fixed within each comparison. Report sample count, successes/failures, p50/p95/p99/max, confidence interval for p95, every >5 s sample, and stage distributions. Never discard timeouts or warm-up overhead silently. A fault cohort cannot improve the ordinary cohort by moving slow successful samples after the fact.

Latency gates depend on correctness gates: unchanged IDs, one writer, no duplicate command apply, valid auth, actual original-session progress, no hidden image rebuild, and no diagnostic pre-wake. A fast wrong-session runtime fails regardless of its timing.

## Commands that are executable today

Run from the repository root unless a subshell changes directory. Scoped paths avoid `node_modules`; exclude `.context` because the retained recovery checkout includes duplicate test filenames with incomplete dependencies. None of these commands invokes live provider suites.

```bash
bunx vitest run infra/api/test/unit packages/sandbox-providers/test/unit \
  apps/server/test/unit/cloud-runtime-updater.test.ts \
  apps/server/test/unit/cloud-runtime-assets.test.ts \
  apps/server/test/unit/cloud-workspace-runtime.test.ts \
  apps/server/test/unit/cloud-provider-auth.test.ts \
  apps/server/test/unit/cloud-codex-auth.test.ts \
  packages/client-runtime/test/unit --exclude '.context/**'

(cd apps/renderer && bunx vitest run \
  test/unit/cloud-attachment-account.test.ts test/unit/rpc-client.test.ts \
  test/unit/rpc-account-lifetime.test.ts test/unit/cloud-ssh-client-bus.test.ts \
  test/unit/session-timeline-client-bus.test.ts --config vite.config.ts)

(cd apps/mobile && bunx vitest run \
  test/unit/rpc/cloud-runtime.test.ts test/unit/store/mobile-client-bus.test.ts \
  test/unit/store/connection-runtime.test.ts test/unit/rpc/connection-failures.test.ts \
  --config vitest.config.ts)
```

Current prototype verification ran each package's `bun run check-types` from its package directory:

| Package | Result |
| --- | --- |
| `infra/api` | Passed |
| `packages/sandbox-providers` | Passed |
| `packages/client-runtime` | Passed |
| `apps/renderer` | Passed, including renderer state check |
| `apps/mobile` | Passed, including test tsconfig |
| `apps/server` | Passed after narrowing fetched fixture JSON before reading `sha256` (initial TS18046 resolved) |

Scoped `bunx biome check` covered 39 existing tracked-changed and untracked TS/JS files, excluding deleted files, `.context` and dependencies. Its four initial diagnostics were resolved with safe import ordering/formatting in `infra/api/src/cloud-workspace-reconciler.ts`, `infra/api/src/cloud-workspace-routes.ts` and `infra/api/src/index.ts`. The repeated 39-file check passed. The server test fixture now validates the fetched manifest object and string digest before access, without a type assertion. Logs: `/tmp/runtime-types-{api,providers,server,client-runtime,renderer,mobile}.log`, `/tmp/runtime-biome.log`; exact checked paths: `/tmp/runtime-biome-paths.txt`. API and server type checks were rerun after those fixes and both passed. The final full API-unit plus updater rerun passed **820 cases in 81 files**, without failures or skips; this rechecks existing baseline cases rather than adding to the total. Evidence: `/tmp/runtime-architecture-final-api-updater.{json,log}`. All six requested package type scripts and the scoped Biome check are green.

The existing real PostgreSQL check is executable only with a verified disposable **local test database**. The supplied localhost target initially returned no response. After the existing disposable local instance was started, `pg_isready -h 127.0.0.1 -p 55451 -U vercel-sandbox -d postgres` confirmed readiness. The integration test then **passed: one test, zero failures or skips**, using only the explicitly scoped `ZUSE_TEST_POSTGRES_URL`; `DATABASE_URL` was not used. This adds one real-store scheduling test to the 1,601-case unit baseline (1,602 distinct cases, 135 files total). JSON/log evidence: `/tmp/runtime-architecture-postgres.{json,log}`. It creates an isolated schema and runs migrations; never point it at production:

```bash
# First verify this explicitly authorized local disposable instance is ready.
pg_isready -h 127.0.0.1 -p 55451 -U vercel-sandbox -d postgres
ZUSE_TEST_POSTGRES_URL='postgres://vercel-sandbox@127.0.0.1:55451/postgres' bunx vitest run infra/api/test/integration/runtime-activation-scheduling.pg.test.ts \
  --exclude '.context/**'
```

Existing live adapter tests are separate, paid, production-endpoint adapter smoke tests. They are not the new product-path latency or retained-session conformance harness. They were **not run**:

```bash
# Run against dedicated disposable resources when the new product path exists.
bunx vitest run packages/sandbox-providers/test/live/boxd.live.test.ts --exclude '.context/**'
bunx vitest run packages/sandbox-providers/test/live/box.live.test.ts --exclude '.context/**'
bunx vitest run packages/sandbox-providers/test/live/e2b.live.test.ts --exclude '.context/**'
```

Presence-only credential inventory: `BOXD_API_KEY`, `BOXD_TEMPLATE_SNAPSHOT`, `BOXD_ORG`, `BOX_API_KEY`, `BOX_TEMPLATE_SNAPSHOT`, `E2B_API_KEY`, and `ZUSE_TEST_POSTGRES_URL` were absent from the process environment and from assignments in `.env`, `.env.local`, `infra/api/.dev.vars`, and `infra/api/.env`. This is not a search of other secret stores or other agents' environments. No credential value was printed, no login or provider connection attempted. A subsequently supplied local PostgreSQL endpoint was verified and used only for the isolated-schema integration test described above; no production database was accessed.

## Reliability-rate interpretation

The canonical target is at most one app-caused visible failure per million logical attempts; a failure still counts if a later retry heals it. Unit cases and a hundred-sample latency pilot cannot establish that rate. Roughly three million independent attempts with zero observed failures are needed for a 95% upper bound near one per million, and correlated faults, selection bias and incomplete instrumentation invalidate a naive independence claim. Track distinct logical attempts rather than inflating the denominator with retries. Stratify provider, version, account/auth cohort and deployment window; preserve tail failures and incident traces. This is a future soak and field-evidence requirement, not a result of the local baseline.

## Delivery order and evidence required before rollout

1. Use the architecture plan’s operation ownership, completion evidence, compatibility policy, and functioning-agent definition of “under five seconds”. Preserve the original production incident evidence as a regression description, not a test environment.
2. Land the shared deterministic lifecycle/conformance fixture and the presently missing failing tests: all-provider activation, bounded confirmation, and durable scheduling through actual completion. Keep each behavior oracle independent of the implementation's branch structure.
3. Run real local processes and SQLite/WAL fault tests, then disposable PostgreSQL and local Worker/DO restart/hibernation tests. Verify cancellation, revocation and client stream recovery together.
4. Run dedicated live conformance on disposable resources against all providers. Retain named test-resource IDs and cleanup only resources created by that run; never adopt a customer workspace for cleanup.
5. Run the Boxd product-path latency cohorts and load experiments. Publish raw redacted spans and uncensored results. Do not claim the under-five-second contract from mock timers, local health polling, queued receipts or a single successful sample.
6. Before rollout, exercise current/previous runtime and current/previous client against the new API, followed by a staged deployment/hibernation soak and rollback drill. Publish immutable signed artifacts and backward-compatible API support before promoting new images.

The release evidence bundle should contain revision + dirty-diff identifier, test commands and counts, fixture IDs/expected identities, failure-injection seeds, local DB integrity results, phase/receipt traces, provider conformance results, latency cohorts, and explicit untested cases. Green unit tests alone do not establish universal live-provider reliability.


## Implementation verification, October 10

The implementation supersedes the baseline's source-gap observations where covered below; the live-provider and latency gates above remain open.

| Selection | Passing cases | Evidence |
| --- | ---: | --- |
| Full API unit suite | 840 | Durable activation/scheduling, explicit update, renewal/boot ACK, passive tickets, pending gateway, executed launcher/fork safety, mailbox dispatch and notification-only wait |
| Full provider unit suite | 256 | Shared launch fencing, warm/cold disposition, E2B real process descendants and abrupt supervisor death, Boat persistent aliases and conflicting databases |
| Selected server runtime suite | 135 | Real signed updater interruption, canonical lifetime FD, persisted identity, renewal response loss/restart, network-only wake reset and fork sanitation |
| Desktop machine-control transport | 19 | Update RPC command forwarding and actual desktop ticket negotiation request the pending protocol |
| Full shared client unit suite | 321 | Actual Effect socket close behavior, initial pending gate, zero mutation replay, connection/resource ownership |
| Selected renderer connection suite | 89 | Account fencing, gateway attachment, RPC lifetime, retained subscriptions |
| Full mobile unit suite | 455 | Direct cloud attachment, wake intents, account fencing and command/resource behavior |
| Public API integration | 34 | Legacy socket hints cannot replace ready owners with valid or expired bearers; authoritative fences still recover |
| Isolated local PostgreSQL integration | 1 | Lease/outbox concurrency, startup completion and renewal/ACK replay against localhost only |

The full renderer unit run additionally passed 1,725 cases and failed one file-search shortcut-dispatch case; the affected connection selection above passes. Seven affected package type checks, applicable Biome checks, shell syntax and diff whitespace checks were run. Exact final results accompany the PR; execution logs are local and are not a provider latency certificate.

No extra machines, warm pool or resident activation listener were introduced. New templates are required to receive image-time systemd/compile-cache priming. Existing compatible runtimes can restart without downloading a newer release; explicit maintenance installs the new runtime. Boat release storage stays in provider-persisted `/opt`; it requires no relocation. Only populated, unaliased `/var/lib` data or ownership directories require a safe cold migration; authoritative lock directories are never copied across devices. See [Boat snapshot capture paths](https://docs.boat.dev/snapshots). Real desktop-origin Boxd under-five-second readiness, multi-day sleep and full provider migration must be verified in staging before broad rollout.

## Live provider verification, October 10

After credentials became available, the current adapters were tested against real provider APIs. Credentials stayed outside the repository in an owner-only temporary file. Five live Vitest cases passed: the existing E2B and Boat lifecycle cases, plus the new shared process-ownership contract on all three providers. Separate diagnostic probes exercised the same ownership behavior and are not counted as additional distinct test cases.

| Provider | Live evidence | Limits |
| --- | --- | --- |
| E2B | Base-template lifecycle: create, hosted HTTP, label recovery, pause/resume, snapshot/fork, network change and cleanup; fenced supervisor launch, same-operation replay, three warm wakes retaining PID, next generation and rejected stale activation | Base template, not the newly published Zuse runtime or an authenticated agent conversation |
| Boat | Published v8 lifecycle, hosted HTTP and installed runtime smoke, persistent file round trip, pause/resume, snapshot/fork and cleanup; cold wake retains fixture files and permits fenced replacement while rejecting stale activation | Existing v8 image; no new runtime publication, retained customer-data migration or multi-day soak |
| Boxd | Disposable isolated stock image: fenced launch, one execution on replay, three sleep/wake cycles retaining PID, next-generation replacement and stale-generation rejection | Supplied credential cannot access configured `zuse-base-v20260927-1`; stock fixture excludes Zuse template startup, gateway and agent readiness |

The standalone Boxd diagnostic measured stock allocation at 1,212 ms and three adapter resume calls at 255, 456 and 460 ms. These are single-run provider/control measurements from this VM, not desktop-to-agent latency or p95/p99 evidence. The first two Boxd diagnostic attempts had fixture mistakes (an assumed systemd unit name and an unprivileged file read); both fixtures were deleted before the corrected successful run.

Repeat the committed live ownership contract with provider credentials supplied through the environment:

```sh
ZUSE_LIVE_PROCESS_OWNERSHIP=1 bunx vitest run test/live/process-ownership.live.test.ts
```

Run from `packages/sandbox-providers`. Requires `E2B_API_KEY`, `BOXD_API_KEY` and optional `BOXD_ORG`, plus `BOX_API_KEY` and `BOX_TEMPLATE_SNAPSHOT` for Boat. The test creates temporary compute, deletes its fixtures in `finally`, and creates no named snapshots. All resources created in the successful checks and diagnostic attempts were cleaned up. The architecture adds no permanent machines or warm pool.

### Boat snapshot cleanup

Provider inventory initially reported 12 named snapshots and $3.40/month in extra snapshot charges. The deployed staging Worker was verified to use base v8. Production image/snapshot references were audited in a read-only transaction; staging references were read through the approved staging Hyperdrive binding using the Mac's existing Wrangler login. Two temporary audit Workers were deleted; the final successful audit used a stopped-after-use remote preview. Python's default request signature initially triggered Cloudflare error 1010; browser-compatible request headers resolved the audit access failure without changing deployment security.

Deleted superseded bases v1, v2, v5, v6 and v7, and two unreferenced October 7 auth/tool test snapshots. Retained base v8 and four explicitly retained project images (two staging, two production). A final provider listing verified five remaining named snapshots, zero snapshots above the free allowance and $0/month in extra snapshot charges. No existing workspace, chat database, provider key or deployed API/runtime was replaced.

The full new API/runtime/client staging journey, signed publication, updated template, expired-token sleep and long-duration provider tests remain rollout gates. Passing these live adapter tests does not close those gates.

## Authenticated staging journey, October 10

The staging API was deployed with the shared runtime-script loader, and the signed runtime release `be5291de53fd4c46149b71283859c46ca2e565cc` was published and verified against the configured staging signing key. An E2B account image was rebuilt successfully with that release. Tests originate on the user's Mac and exercise the real public API, durable mailbox, gateway, guest runtime and Codex CLI using a working account model. They do not measure a literal desktop tab click.

Timing starts immediately before the authenticated create/send request. Agent receipt means the CLI has answered `turn/start`, recorded after the awaited response; HTTP acceptance and provider resume are separate boundaries. Guest/local clock offsets were bounded by a timed guest clock command, so ranges include calibration uncertainty rather than claiming false millisecond precision. Tiny cohorts establish neither p95/p99 nor a one-in-a-million failure rate.

| E2B cohort | Samples | Actual agent receipt bounds | Observed completed reply |
| --- | ---: | --- | --- |
| Existing awake workspace | 5 | 1.27–4.39 seconds across samples | 5.54–11.67 seconds |
| Paused workspace, send initiates wake | 3 | 5.47–8.27 seconds across samples | 10.39–12.20 seconds |
| Fresh workspace from rebuilt image | 1 | 30.44–33.05 seconds | 37.27 seconds |

Paused measurements make no guest diagnostic calls between pause confirmation and the actual send: such calls can wake E2B and invalidate the measurement. The previous stock Boxd allocation/resume values above remain provider-only evidence and must not be presented as agent receipt.

Live staging transitions verified: same-ID message replay produced one user/assistant pair; three paused sends recovered; a credential was allowed to expire naturally while its workspace slept, then a prompt completed in 22.74 seconds with one execution, retained chat/session IDs and the same runtime generation with a renewed expiry; normal desktop access-token refresh restored authenticated access after an expired verification request; signed upgrades retained identities; three client socket reconnects verified gateway availability in 1.85–2.79 seconds; replacing and dropping the runtime's socket healed, followed by five completed real agent turns. Gateway availability is not proof of desktop RPC subscription continuity.

The first old-image pause returned HTTP 503; the remaining pause cycles succeeded, and that failed prerequisite is retained in the evidence rather than counted as a passing wake. Two early agent runs used unsupported account models; corrected runs use `gpt-5.6-luna`. Diagnostic fixture mistakes (expecting gateway state `ready` instead of `available`, and waking a paused guest with a diagnostic read) were corrected and excluded from latency cohorts. Interrupted signed update and lost renewal response/process restart have real local fault tests, not full live provider certification; a two-day sleep uses a controlled-clock test rather than a two-day soak.

### Boxd source resolution defect and remaining gates

The installed Boxd SDK accepts snapshot **names** for lookup and restore, while imported account images store immutable snapshot **IDs**. The shared adapter now resolves an imported ID within its connection's organization, restores by name, and checks the immutable ID/version before and after allocation. Lookup outages propagate rather than becoming absence, and a replaced image cannot silently satisfy a pinned reference. Managed image restore retains its existing direct path. Provider type checks, applicable Biome and all 260 provider unit cases pass, including ID restore, missing source, transient lookup and a snapshot replacement race.

The fix was deployed to staging API version `4080bed8-5631-4bac-8e47-c53e2cf3488a`. Retrying the selected Boxd connection still failed before assigning a machine; the latest supplied key authenticates but lists no snapshots both in its default context and explicit organization `zuse`. Thus full prepared Boxd timing is still blocked by access to the selected image, independently of the confirmed adapter defect. Boat's current staging connection rejects its image build with permission denied. Neither provider has a qualified full agent timing result, and Boxd's under-five-second goal is still open. Production was not deployed or modified.

An additional runtime socket replacement/drop occurred during an unfinished agent turn; the turn completed after 27.80 seconds with exactly one user message and one assistant reply. Repeating its idempotency key returned the existing canonical message ID; its delivery status progressed, so the complete receipt payload was not byte-for-byte identical. This is an in-flight durable mailbox/agent test, not an assertion that a desktop partial stream visually resumes without interruption.

All five E2B test sandboxes were deleted through the staging API and independently returned missing from the provider. Two failed Boxd test records never received a provider sandbox ID; their delete requests were rejected by the inaccessible pinned connection, so those diagnostic records remain pending cleanup. No unrelated workspace was deleted; the rebuilt E2B image is retained as the current staging image. The disposable public API test key was revoked after testing.
