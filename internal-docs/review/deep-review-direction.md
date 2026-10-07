# Zuse Review: repository understanding and executable verification

Status: hosted MVP implementation with release gates, 2026-10-07. The repository now includes native Claude review sessions, immutable indexed retrieval in an isolated reader process, dedicated native-auth sandbox lifecycle, publication, and a separate paired-check runner. No provider is release-eligible until authorization, exact-binary confinement and live infrastructure/auth/billing staging pass. The deeper semantic-graph and hypothesis-driven execution described below remain future work.

## Intended result

A useful review explains how a change affects a real workflow, investigates the relevant callers and contracts, and tests a suspected failure when an appropriate environment is available. It should be able to say: “This producer now emits a nullable value; this unchanged consumer dereferences it; the same reproduction passes before the change and fails afterward.” Merely summarizing a diff, searching neighboring files, or having a second model agree is insufficient.

Architecture means concrete boundaries, dependencies and invariants. Relevant processes include both runtime processes and product workflows: requests, jobs, events, persistence, authorization, retries, reconnection, cleanup and billing settlement. Store their supporting code/document locations and versions. Do not present generated architecture prose as authoritative truth.

**Scope update:** this direction supersedes the earlier blanket exclusion of repository code execution **only in a separately provisioned, credential-free test runner**. The native-auth review worker remains read-only and must not execute repository scripts, install dependencies, start application servers, or mount the runner's writable filesystem. No existing user workspace or account image containing credentials may be cloned into a test runner.

## Existing foundation and concrete gaps

| Area | Exists | Still needed |
| --- | --- | --- |
| Comparison | Immutable repository/base/head/merge-base identities; Git-object reads; bounded patches and explicit partial output | Durable impact/coverage records; distinct merge-base regression and target-base integration comparisons |
| Repository retrieval | `packages/index`: content deduplication, immutable manifests, TS/JS symbol chunks, BM25, relative static imports/re-exports | TS project/alias/package export resolution, authoritative references where supported, changed-symbol mapping, workflow maps, dependency/test relationships, versioned documentation facts |
| Investigation | `packages/review`: bounded read/search/related-file tools, injected investigator, fresh verifier, quoted evidence and changed-line validation | Explicit hypotheses, counterexample search, impact-driven task routing, execution requests and artifacts, richer verifier dispositions |
| Agent lifecycle | Real pinned Claude SDK investigator/verifier, fresh structured sessions, process-group cleanup, typed auth/quota failures, dedicated native login/callback and paused auth sandbox | Provider authorization and exact-binary adversarial proof; live refresh/resume/account-match staging; additional eligible providers |
| Execution primitives | Separate credential-free runner image; fixed base-approved root test/typecheck commands paired at merge-base/head; frozen script-free dependency preparation; network quarantine before execution; bounded evidence, aggregate budget, usage and cleanup lifecycle | Hypothesis-specific generated regressions, service-backed integration profiles, richer artifacts, flaky-test handling and language coverage |
| Evaluation | Human-adjudicated corpus gates, metrics and synthetic behavior tests | Frozen real corpus, executable regression cases, architecture/cross-file slices, matched ablations and live staging evidence |

The existing `refs` table is not a populated semantic call graph. Static imports currently resolve relative paths conservatively and leave aliases unresolved. There is no general workflow model. The implemented runner executes conventional root test/typecheck scripts, not model-generated reproductions or arbitrary application workflows. Existing shell/process helpers manage execution lifecycle; they are not a security boundary by themselves. Current hosted readiness remains blocked independently of implementation availability.

## Architecture and ownership

Keep one capability owner per responsibility. Extend `packages/index` for repository intelligence, `packages/review` for review planning and evidence decisions, `packages/contracts` for wire schemas, `apps/server` for agent/runner composition, and `infra/api` for leases, authorization, scheduling, publication and metering. Reuse `packages/sandbox-providers` and the shared billing pipeline. Do not create another provider framework or put orchestration in contracts.

Three separate execution authorities are required:

1. **Reviewer:** has the user's eligible model connection and bounded repository-reading tools. It proposes hypotheses and test requests. It cannot choose credentials, authorize spending, write GitHub comments, or execute repository code.
2. **Control plane:** authorizes a request against the run's pinned comparison, owner, approved execution profile and remaining budget; creates a runner attempt; supplies source/dependencies; records lifecycle and artifacts. A model-produced command is never sufficient authorization.
3. **Test runner:** contains source, tools and disposable test services, without model credentials, GitHub write credentials, user session databases, cloud credentials or production secrets. It executes the admitted request and returns bounded results. Its outputs are untrusted repository-controlled data, not instructions or permission to run further commands.

Use provider-enforced network restrictions, resource limits and provider termination deadlines. Process-group cleanup complements that boundary. A test result cannot prove a sandbox stopped: confirm termination separately. Initial runner connectivity is denied except controlled artifact/bootstrap channels; dependency fetching uses an isolated preparation stage and approved registry access. Prefer a populated dependency cache keyed by tenant, toolchain, lockfile and platform; never reuse mutable environments between untrusted jobs. Private dependencies without a credential-isolating fetch service are explicitly unsupported initially. No production database or production network access.

## Phased delivery

### 1. Repository facts and change impact

Build a versioned repository map from pinned source: package/workspace manifests, language/toolchain versions, project references, exports, source roots, test projects, CI commands, schemas, routes, job/event registrations and architecture documents. Read configurations as data. A JS test/build configuration may execute code when imported; import it only inside the test runner.

For TS/JS, add compiler-assisted symbol/reference resolution with a restricted file host, including workspace package exports and `tsconfig` path aliases. Record resolved edges separately from lexical candidates and unresolved dynamic references. Trace a changed symbol to direct callers/callees, consumers of its exported contract, nearby tests, and relevant entrypoints. Start with two dependency hops and expand when a concrete hypothesis warrants it; record every truncated frontier. This is an exploration budget, not proof that two hops cover the impact.

Map workflows as cited paths through components: entrypoint → authorization → state transition → side effect → consumer → failure/recovery path. Initially derive candidate paths from code and documents and let investigators verify them. Queue names, event keys and SQL/schema references need dedicated extractors; a file-import graph cannot establish these links alone. Cached summaries must include supporting blob identities and be invalidated when sources or extractor versions change. Explicit maintainer rules from the trusted base revision can guide review; PR edits to those rules cannot enlarge execution privileges.

Acceptance: seeded cross-package changes resolve affected unchanged callers and test candidates; ambiguous resolution stays unknown; stale indexes and changed docs never supply silently current facts. Add reference-resolution fixtures for re-exports, aliases, overloads, dynamic imports, monorepos and deleted symbols.

### 2. Hypothesis-driven investigation

Replace a single generic review prompt with a durable investigation plan per risk cluster. Each hypothesis identifies the changed behavior, affected workflow, triggering conditions, expected invariant, possible consequence, and evidence needed to confirm or refute it. Route correctness, authorization/data integrity, asynchronous lifecycle and migration risks according to changed surfaces rather than running every specialist on every PR.

Investigators inspect both snapshots, affected unchanged code, tests and applicable rules. They must seek an existing guard or alternative explanation before escalation. Record inspected symbols and evidence; model-reported file counts alone are not coverage telemetry. Run one investigator session at a time per provider connection by default; parallelize deterministic indexing and runner work only when separately budgeted and authorized. A fresh verifier must reconstruct the issue from source and artifacts, not receive the original agent's private transcript.

Extend evidence beyond quotes: source-supported, statically diagnosed, reproduced, contradicted, inconclusive. Separate impact location from changed-line publication anchor so a defect manifested in an unchanged consumer is not discarded solely because that consumer is outside the diff. Anchor the causal change inline when possible; otherwise retain a source-linked finding in the summary. Do not manufacture a changed-line anchor.

Acceptance: known bugs outside changed files survive publication; speculative/pre-existing findings are rejected; a second model's agreement alone never upgrades a finding to reproduced.

### 3. Executable verification

Add a typed verification request with run/hypothesis IDs, snapshot, approved execution-profile version, working directory, tool/argument vector, optional generated-test artifact digest, disposable service requirements and explicit limits. Profiles are approved per repository from trusted configuration. They enumerate dependency preparation and permitted test/build/static-analysis entrypoints; they are not arbitrary shell escape hatches. Profile resolution is control-plane work. Generated repro scripts are allowed within the same isolated runner boundary and budget; approval of a test profile is not trust in the test code.

Start with existing relevant tests and type/static checks. If those cannot settle a concrete hypothesis, generate a minimal deterministic reproduction. Run the **same reproduction** against merge-base and PR head using pinned toolchain, equivalent fixtures and each revision's declared dependencies. Head failure plus baseline success supports introduction by this PR. Failure on both revisions is pre-existing or inconclusive; setup failure, timeout and missing service are never bug proof. A test that cannot compile against the baseline needs a compatibility adaptation independently reviewed and recorded, or remains unproven. Record test-code hashes and inspect the asserted behavior to reject tautological tests that merely assert the new implementation.

Use the current target-base SHA separately when testing integration with changes that landed after the merge-base. A synthesized merge has its own recorded tree identity and provenance and must not be mislabeled as the PR head. Do not silently replace the regression baseline with the latest target branch.

For timing/concurrency hypotheses, record seeds and schedule perturbations and repeat only within the accepted budget. Inconsistent results are flaky/inconclusive. Later support disposable database fixtures, process/reconnect scenarios and browser flows with recorded requests/screenshots; services stay within the runner's private network. Process diagrams are not enough: verify real lifecycle behavior such as cancellation stopping descendants and duplicate delivery not duplicating a side effect.

The trusted runner supervisor records requested and actual command, image/toolchain/source/test digests, preparation outcome, exit/signal/timeout, bounded logs, duration, service fixture identity and termination evidence. Parse structured test reports where supported; distinguish “command exited zero” from actual selected tests passing. Signed envelopes bind artifacts to an admitted attempt, but repository-written reports still require consistency checks. Only the trusted publisher renders screened, bounded evidence.

Acceptance: malicious hooks/tests cannot read model credentials or reach production; fork/source isolation is tested; baseline/head substitutions and forged artifact attribution are rejected; zero-tests, crashes, partial logs, infrastructure failures and flaky repros remain inconclusive; cancel/restart terminates or quarantines attempts without duplicate charges.

### 4. Quality, operating cost and rollout

Preserve the existing ten-minute aggregate worker allocation default until product settings explicitly change. Index preparation, reviewer workers, test runners, retries and concurrent runner allocations consume one authorized run budget, with settled provider evidence attributed per attempt. Waiting in a queue is not compute. Two runners each allocated for five minutes consume ten worker-minutes even if concurrent. A deep review that cannot fit reports incomplete verification; it must not quietly raise the cap, switch payer/provider, or claim full validation.

Show three dimensions separately: changes investigated, affected dependencies inspected/unresolved, and verification attempted/passed/failed/inconclusive/skipped. Include skipped commands and the actual reason. “No findings” is not “all tests passed” and no-result/partial runs never imply safe merging. Public comments explain the failure scenario and evidence grade; useful source-supported findings need not be suppressed just because running the full application is unavailable.

Evaluate the same held-out cases through direct-diff review, repository-context review, hypothesis review and executable verification. Measure adjudicated precision, clean-PR false positives, cross-file/high-severity recall, test-reproduced findings, unresolved coverage, latency and settled compute. Keep repository-disjoint splits and report uncertainty; do not tune on published hold-out labels. Add product-flow, restart/reconnect, migration and negative cases. Shadow → human-approved publication → opt-in automatic comments; no parity or production-readiness claim without matched results and live lifecycle/billing evidence.

## Contracts and persistence to add

Keep the current ReviewResult compatible while adding versioned optional investigation, impact and verification summaries. Introduce `ReviewHypothesis`, `ReviewImpactPath`, `ReviewVerificationRequest`, `ReviewVerificationAttempt` and `ReviewEvidenceArtifact` in contracts; behavior belongs to review/server/control-plane modules. Persist attempt state, immutable artifact digests and coverage independently from model transcripts. Execution states should distinguish preparation, running, collecting, terminating, terminated and unknown cleanup; verification verdicts must not double as lifecycle states.

Use existing run/connection leases and comparison fencing for admission. Child test attempts inherit owner, comparison and budget but receive no subscription authority. Superseding a head cancels future work, fences stale results and requests termination. Settled cost records survive cancellation. Keep scratch test data entirely separate from existing cloud workspace runtime databases and recovery paths.

## Complexity and boundaries

This is a substantive engine and execution-system project, not an OSS wrapper or a prompt revision. Rough planning ranges for experienced engineers are 2–4 engineer-weeks for repository facts/resolution, 2–4 for impact and hypothesis orchestration, 3–6 for runner isolation/profiles/paired evidence, and 3–5 for evaluations, recovery and rollout integration. These ranges overlap and are not a calendar commitment; these estimates describe the future advanced engine, not the implemented narrow hosted MVP. Production subscription eligibility and live verification of the implemented dispatch/auth/billing wiring remain launch dependencies. A narrow TS/JS pilot is credible before broad language or application parity. Private dependency preparation, flaky distributed tests and persistent quality evaluation are likely long poles.

Do not launch a universal graph, cross-repository access, production-observability ingestion, automatic fixes/merge, or arbitrary external-network test environments in the first phase. Extend only after representative cases demonstrate measurable added value and maintainers explicitly authorize the data/process scope.

## Primary-source capability context

Official product documentation describes repository-wide relationships plus deterministic scanners in modern review products; another vendor describes codebase knowledge, impact tracing and runtime/user simulation in a July 2026 direction article. These are vendor descriptions, not independent quality measurements, and the direction article is not proof that every listed capability is generally available. A published evaluation page emphasizes bugs at their introducing commits, supporting paired historical evaluation as a useful methodology. None establishes Zuse parity or a benchmark result for this implementation.

- [Repository-context and analysis capabilities](https://docs.coderabbit.ai/guides/code-review-overview), consulted 2026-10-07.
- [Code validation direction and runtime investigation](https://www.greptile.com/blog/automating-code-validation), published 2026-07-10; consulted 2026-10-07.
- [Historical introducing-commit benchmark methodology](https://www.macroscope.com/benchmark), consulted 2026-10-07.


## Implemented MVP execution and reproducibility

The runtime executes native structured Claude sessions using the existing pinned SDK. A trusted root supervisor runs native code as uid1000 and immutable Git/index reads as uid1001; each child's environment is allowlisted. The reader cannot read the private native authhome or supervisor environment, and the native process cannot read repository files directly. Native tool suppression still requires adversarial proof against the exact shipped binary. Tests run only after native cleanup and pause, in a different sandbox with no subscription auth. This preserves one authorized aggregate run budget and never puts repository setup scripts into the subscription sandbox.

The check profile selects at most `test`, `typecheck`, and `check-types` from the merge-base root manifest. It executes the identical command at both revisions, records separate passed/failed/timeout/inconclusive outcomes, and publishes no claim that an existing test failure proves a particular model finding. An exclusive root run lock plus durable launch marker prevents duplicate execution after delayed status or an unknown launch response. Evidence is persisted before termination; uncertain teardown preserves that evidence for reconciliation.

Supported dependency preparation is registry-only npm or Bun text lockfiles, including bounded declared workspaces and Bun catalogs. Local workspace links must match declared in-checkout packages. Installs ignore lifecycle scripts; repository manager configuration, external dependency URLs, unknown local links, binary Bun lockfiles and unsafe filesystem paths fail conservatively. Large installs/full monorepo suites may exceed the allocated budget and remain inconclusive. No private registry credentials, production services or provider model credentials are supplied. Missing scripts are reported `not_available`, never as passed checks.

Build and inspect locally without provider credentials:

```sh
node apps/server/scripts/build-review-worker.mjs
sudo node apps/server/scripts/probe-review-isolation.mjs
sudo node apps/server/scripts/probe-review-checks.mjs
docker build -f apps/server/review-image/Dockerfile -t zuse-review-worker:local apps/server
docker build -f apps/server/review-image/Dockerfile.checks -t zuse-review-checks:local apps/server
```

The build emits `apps/server/dist-review/manifest.json` with native/worker hashes and `releaseApproved: false`. The check image copies only the standalone runner and JSONC parser, never the native agent or auth data. Both images require trusted root supervisors; their untrusted children drop to distinct UIDs. Deployment must pin images, provision separate templates, enforce registry-only preparation followed by network quarantine for tests, and verify provider termination/usage settlement. The root-owned status file is `/run/zuse-review-checks/status.json`; the control plane invokes `/opt/zuse/review-check-runner.mjs prepare|run` with immutable SHAs and a hard deadline. Only `prepare` receives a transient read-only GitHub token.

Actual credential-free probes cover UID permission canaries, immutable source reads, indexed search/import edges, base-success/head-failure, root-status protection, absent child credentials, parent-environment denial, timeout termination, and missing-script reporting. They do not establish live subscription permission, full agent confinement, or Greptile-equivalent quality. See [provider feasibility](provider-feasibility.md) for the remaining release evidence.
