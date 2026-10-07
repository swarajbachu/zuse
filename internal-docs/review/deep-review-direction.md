# Zuse Review: repository understanding and executable verification

Status: proposed implementation direction, 2026-10-07. This extends the disabled foundation; it does not describe a working hosted review service. Inspected the review/index implementation and the main-branch sandbox/runtime interfaces during the rebase onto `98701f95`. No conflict files or runtime state were changed for this assessment.

## Intended result

A useful review explains how a change affects a real workflow, investigates the relevant callers and contracts, and tests a suspected failure when an appropriate environment is available. It should be able to say: “This producer now emits a nullable value; this unchanged consumer dereferences it; the same reproduction passes before the change and fails afterward.” Merely summarizing a diff, searching neighboring files, or having a second model agree is insufficient.

Architecture means concrete boundaries, dependencies and invariants. Relevant processes include both runtime processes and product workflows: requests, jobs, events, persistence, authorization, retries, reconnection, cleanup and billing settlement. Store their supporting code/document locations and versions. Do not present generated architecture prose as authoritative truth.

**Scope update:** this direction supersedes the earlier blanket exclusion of repository code execution **only in a separately provisioned, credential-free test runner**. The credentialed review worker remains read-only and must not execute repository scripts, install dependencies, start application servers, or mount the runner's writable filesystem. No existing user workspace or account image containing credentials may be cloned into a test runner.

## Existing foundation and concrete gaps

| Area | Exists | Still needed |
| --- | --- | --- |
| Comparison | Immutable repository/base/head/merge-base identities; Git-object reads; bounded patches and explicit partial output | Durable impact/coverage records; distinct merge-base regression and target-base integration comparisons |
| Repository retrieval | `packages/index`: content deduplication, immutable manifests, TS/JS symbol chunks, BM25, relative static imports/re-exports | TS project/alias/package export resolution, authoritative references where supported, changed-symbol mapping, workflow maps, dependency/test relationships, versioned documentation facts |
| Investigation | `packages/review`: bounded read/search/related-file tools, injected investigator, fresh verifier, quoted evidence and changed-line validation | Explicit hypotheses, counterexample search, impact-driven task routing, execution requests and artifacts, richer verifier dispositions |
| Agent lifecycle | `apps/server/src/review/worker.ts`: adapter harness, cancellation and fresh-session checks | Eligible production subscription adapter; connected dispatch remains disabled |
| Execution primitives | Main branch has sandbox create/fork, network policy, timeout, inspect/kill and usage interfaces; process-group supervision and per-execution authorization | Credential-free review runner image/protocol, approved test profiles, artifact ingestion, paired runs, cleanup attestation and review-specific budget integration |
| Evaluation | Human-adjudicated corpus gates, metrics and synthetic behavior tests | Frozen real corpus, executable regression cases, architecture/cross-file slices, matched ablations and live staging evidence |

The existing `refs` table is not a populated semantic call graph. Static imports currently resolve relative paths conservatively and leave aliases unresolved. There is no general workflow model or test runner. Existing shell/process helpers manage execution lifecycle; they are not a security boundary by themselves. Current hosted readiness remains blocked independently of this proposal.

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

This is a substantive engine and execution-system project, not an OSS wrapper or a prompt revision. Rough planning ranges for experienced engineers are 2–4 engineer-weeks for repository facts/resolution, 2–4 for impact and hypothesis orchestration, 3–6 for runner isolation/profiles/paired evidence, and 3–5 for evaluations, recovery and rollout integration. These ranges overlap and are not a calendar commitment; production subscription eligibility and the still-missing hosted dispatch/auth/billing wiring are additional launch dependencies. A narrow TS/JS pilot is credible before broad language or application parity. Private dependency preparation, flaky distributed tests and persistent quality evaluation are likely long poles.

Do not launch a universal graph, cross-repository access, production-observability ingestion, automatic fixes/merge, or arbitrary external-network test environments in the first phase. Extend only after representative cases demonstrate measurable added value and maintainers explicitly authorize the data/process scope.

## Primary-source capability context

Official product documentation describes repository-wide relationships plus deterministic scanners in modern review products; another vendor describes codebase knowledge, impact tracing and runtime/user simulation in a July 2026 direction article. These are vendor descriptions, not independent quality measurements, and the direction article is not proof that every listed capability is generally available. A published evaluation page emphasizes bugs at their introducing commits, supporting paired historical evaluation as a useful methodology. None establishes Zuse parity or a benchmark result for this implementation.

- [Repository-context and analysis capabilities](https://docs.coderabbit.ai/guides/code-review-overview), consulted 2026-10-07.
- [Code validation direction and runtime investigation](https://www.greptile.com/blog/automating-code-validation), published 2026-07-10; consulted 2026-10-07.
- [Historical introducing-commit benchmark methodology](https://www.macroscope.com/benchmark), consulted 2026-10-07.
