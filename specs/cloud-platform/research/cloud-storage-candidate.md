# Candidate Git storage service for cloud-agent runs

Research date: 2026-07-17

## Bottom line

The candidate is useful as an **optional Git backing service**, but it is not the cloud workspace layer described by the product flow.

It can give every task an isolated Git ref or independent repository, provide short-lived repository credentials, accept commits without a local Git process, and keep code portable across compute providers. It does **not** provide a Linux machine, a mounted workspace, process snapshots, databases, browser control, video recording, hosted application URLs, machine suspend/resume, or desktop/mobile run synchronization. Its own sandbox guide explicitly treats execution environments as a separate provider and has those environments clone code over Git. ([Introduction](https://code.storage/docs/getting-started/introduction), [Sandboxes](https://code.storage/docs/guides/sandboxes))

Recommendation: do not make this service a prerequisite for the first cloud-agent architecture. Keep the internal `RepositoryStore`/workspace-source boundary provider-neutral, and test the candidate later as a Git acceleration and isolation adapter. The first proof should compare task-start time and failure recovery against an ordinary shallow clone from the current source host; it should not attempt to use this service as a machine or filesystem snapshot mechanism.

## Fit by requirement

| Requirement | Finding | Fit |
| --- | --- | --- |
| Prepared multi-repository Linux workspace | The service stores Git repositories. Its documented sandbox flow creates compute elsewhere and clones repositories into it. Repository tokens are scoped to one repository, except organization-wide listing tokens, so a multi-repository workspace would require independently issued URLs and clones. No atomic multi-repository workspace snapshot is documented. ([Authentication](https://code.storage/docs/getting-started/authentication), [Sandboxes](https://code.storage/docs/guides/sandboxes)) | Partial source-code bootstrap only |
| Per-task isolation | Disposable branches live in an isolated namespace and share Git objects; independent repository forks can be created from HEAD, a ref, or an exact commit. Forks are limited to the same organization, copy all history up to the fork point, and do not retain a parent relationship. ([Ephemeral branches](https://code.storage/docs/guides/ephemeral-branches), [Forking](https://code.storage/docs/guides/forking)) | Strong for Git state |
| Snapshot/clone of a running workspace | A documented “snapshot” is a repository fork at a commit. It does not capture uncommitted files, installed dependencies, running processes, caches, databases, secrets, or browser state. ([Forking](https://code.storage/docs/guides/forking)) | No |
| POSIX/filesystem semantics | The service promises real Git storage and standard Git semantics over HTTPS. The API can list and stream repository files, including Git types such as blobs, trees, symlinks, and submodules, but the docs expose no POSIX mount or writable shared filesystem. ([Introduction](https://code.storage/docs/getting-started/introduction), [List files](https://code.storage/docs/reference/api/files/list-files), [Git operations](https://code.storage/docs/guides/git-operations)) | No mounted filesystem |
| Low-latency attach | The recommended fast path is still a shallow, single-branch clone. Marketing claims clones are 60 times faster than object-store-backed alternatives, but publishes no benchmark method or absolute latency. No mount/attach API, fork latency, throughput guarantee, or latency SLO is published. Cold repositories thaw automatically on clone/fetch and the docs warn that this adds latency. ([Sandboxes](https://code.storage/docs/guides/sandboxes), [Imports](https://code.storage/docs/guides/imports), [Product page](https://code.storage/)) | Unknown until benchmarked |
| Persistence and suspend/resume | Repository data is persistent and automatically moves between hot storage and object-backed cold storage. This is code persistence, not machine suspend/resume; no API for suspending or restoring compute or live processes is documented. ([Introduction](https://code.storage/docs/getting-started/introduction), [Imports](https://code.storage/docs/guides/imports)) | Git recovery only |
| Concurrent agents | Standard Git refs provide the concurrency model. Ephemeral refs or forks isolate writers; merge operations can require an expected target SHA, and notes support optimistic concurrency with an expected ref SHA. This does not provide concurrent access to one live filesystem. ([Merge branch](https://code.storage/docs/reference/api/branches/merge-branch), [Git notes](https://code.storage/docs/guides/git-notes)) | Good for ref-level coordination |
| Region/provider constraints | The service is exposed as an organization-specific managed HTTPS endpoint. Marketing says storage can be colocated near agents or managed on customer hardware, and pricing offers managed and enterprise self-hosted options. No public region list, cloud-provider matrix, data-residency choices, placement API, or failover topology was found. The sandbox integration is intentionally compute-provider-neutral. ([HTTP API](https://code.storage/docs/reference/api/overview), [Sandboxes](https://code.storage/docs/guides/sandboxes), [Product page](https://code.storage/), [Pricing](https://code.storage/pricing)) | Potentially flexible; material details unknown |
| Browser/video evidence | Git LFS supports large files, including video paths, using managed object storage, with a documented 5 GiB maximum per object. However, LFS is repository-scoped, has no file-locking API, and server-side repository forks copy pointer files but not LFS bytes, causing pulls from a fork to fail. No evidence manifest, streaming player URL, retention policy, thumbnailing, or CDN is documented. ([Git LFS](https://code.storage/docs/guides/git-lfs)) | Poor primary evidence store; possible archive only |
| Hosted preview routing | “Preview” branches are Git refs. No service discovery, port exposure, TLS preview domain, access-control layer, browser session, or reverse proxy is documented. ([Ephemeral branches](https://code.storage/docs/guides/ephemeral-branches)) | No |
| Secrets and isolation | Customer-signed JWTs can be short-lived, scoped to one repository, limited to read/write operations, and constrained by ref policies. The sandbox guidance recommends short TTLs, minimal permissions, ephemeral branches, and human review before protected-branch merge. The SDK helper’s documented default token lifetime is one year, so the control plane must always override it. Marketing claims per-tenant deployments and encryption, annual third-party penetration tests, external code audits, and fine-grained audit/access controls, but the reviewed technical docs do not describe the encryption design, KMS/BYOK, tenant-isolation mechanism, dynamic token revocation, audit schema/retention, compliance reports, or how stored upstream credentials are encrypted. ([Authentication](https://code.storage/docs/getting-started/authentication), [Branch protection](https://code.storage/docs/guides/branch-protection), [Sandboxes](https://code.storage/docs/guides/sandboxes), [Integrations](https://code.storage/docs/guides/integrations), [Product page](https://code.storage/)) | Useful least-privilege Git access; insufficient workspace security layer |
| Desktop/mobile control plane | Plain HTTPS APIs and signed webhooks can support a server-side integration from any client-facing control plane. Webhooks cover pushes and repository-sync lifecycle events with HMAC verification and retries. No agent-run state, transcript replay, device synchronization, approval commands, live preview, takeover, or offline command semantics are provided. ([HTTP API](https://code.storage/docs/reference/api/overview), [Webhooks](https://code.storage/docs/guides/webhooks)) | Backend building block only |

## Where it could help the flow

1. **Task code isolation.** Create one ephemeral branch for cheap short work or one independent repository fork for stronger namespace isolation. The control plane must record lineage itself because repository forks do not retain their parent relationship. ([Ephemeral branches](https://code.storage/docs/guides/ephemeral-branches), [Forking](https://code.storage/docs/guides/forking))
2. **Portable compute bootstrap.** Mint a short-lived, repository-scoped URL and give it to whichever Linux execution provider starts the task. A shallow clone lets the compute layer remain replaceable. ([Authentication](https://code.storage/docs/getting-started/authentication), [Sandboxes](https://code.storage/docs/guides/sandboxes))
3. **Server-side code operations.** The HTTPS API can list files, stream diffs, create atomic commits from files or patches, preview merges, and merge branches without installing Git in the control plane. This may simplify mobile-friendly review and recovery services, although the actual agent still needs a normal working tree to build and test a real application. ([HTTP API](https://code.storage/docs/reference/api/overview), [Create commit from files](https://code.storage/docs/reference/api/commits/create-commit-from-files), [Create commit from diff](https://code.storage/docs/reference/api/commits/create-commit-from-diff), [Preview merge](https://code.storage/docs/reference/api/branches/preview-merge))
4. **Git event ingestion.** Signed push and sync webhooks can update the run timeline without polling. Delivery has automatic retries, but the public guide does not publish retry timing or maximum attempts. ([Webhooks](https://code.storage/docs/guides/webhooks))
5. **Upstream compatibility.** Repositories can mirror an external Git host and successful pushes trigger background synchronization. Ephemeral branches deliberately stay internal until promoted, which can keep experimental agent work away from the canonical host. ([Integrations](https://code.storage/docs/guides/integrations), [Ephemeral branches](https://code.storage/docs/guides/ephemeral-branches))

## What must remain separate

The following still need dedicated platform components:

- a Linux VM/container provider;
- prepared machine images or volume snapshots for dependencies and caches;
- lifecycle management for create, boot, health, pause, resume, hibernate, and destroy;
- database and service orchestration;
- an application-secret broker with audit, rotation, revocation, and per-run injection;
- browser/desktop automation and virtual displays;
- video capture plus object storage/CDN delivery;
- authenticated port routing for hosted previews;
- the durable run/message/event store shared by desktop and mobile;
- policy, budgets, cancellation, approvals, and the merge queue.

The candidate can restore committed code after a failed machine. It cannot restore a machine to its live state.

## Pricing, limits, and maturity

### Confirmed

- Public docs describe cursor pagination with a maximum of 100 items per page and Git LFS objects up to 5 GiB. These are endpoint/file limits, not account quotas. ([HTTP API](https://code.storage/docs/reference/api/overview), [Git LFS](https://code.storage/docs/guides/git-lfs))
- Published usage pricing is $1.00 per hot GiB per month **per replica**, with a three-replica minimum; $0.15 per cold GiB per month after more than seven untouched days; $0.06 per inbound GiB; and $0.15 per outbound GiB. This makes the minimum hot-storage line effectively $3.00/GiB/month before bandwidth at the documented replication floor. Managed and enterprise self-hosted deployments are offered by contact rather than with public fixed prices. ([Pricing](https://code.storage/pricing))
- The product page claims no rate limits, at least three replicas, consistent replicas, and a 99.99% SLA for multi-availability-zone deployments. The legal SLA also states a 99.99% monthly availability commitment, although its definition of availability refers to assisting with “labeling” customer data rather than serving Git operations; that wording needs clarification before relying on the commitment. ([Product page](https://code.storage/), [SLA](https://code.storage/legal/sla))
- The official SDK repository is public, was created on 2026-01-30, and remains active; the current manifests expose TypeScript, Python, and Go clients. The Python package classifies itself as beta, while current manifests use `1.x` versions. ([Repository metadata](https://api.github.com/repos/pierrecomputer/sdk), [SDK packages](https://github.com/pierrecomputer/sdk/tree/main/packages), [Python package manifest](https://github.com/pierrecomputer/sdk/blob/main/packages/code-storage-python/pyproject.toml))
- The first-party changelog begins with the public introduction on 2025-10-14 and shows frequent feature changes through 2026-06-25. This supports active development, not long production history. ([Changelog](https://code.storage/changelog))
- The reference still publishes deprecated `/api/v1` endpoint variants alongside current endpoints, indicating active API migration that an adapter should shield from product code. ([Create repository API](https://code.storage/docs/reference/api/repositories/create-repo-1), [Current create repository API](https://code.storage/docs/reference/api/repositories/create-repo))

### Not found in the reviewed first-party material

- free allowance, per-operation billing, minimum monthly commitment, discount schedule, or overage policy;
- organization/repository/branch/total-storage quotas, concurrency limits, or enforceable throughput terms behind the marketing claim of no rate limits;
- support response targets, backup/restore guarantees, or enough public status history to assess reliability;
- fork and clone latency targets or throughput limits;
- concrete region selection, residency, subprocessor/cloud-provider details, or disaster-recovery topology;
- encryption-at-rest algorithms, key-management guarantees, or customer-managed keys;
- retention windows for cold repositories, deleted data, webhook deliveries, or audit records.

These unknowns block a production commitment. They do not block a small, non-critical benchmark.

## Operational risks

- **Wrong abstraction risk:** treating repository forks as machine snapshots would lose uncommitted files and all non-Git state.
- **Cold-start variance:** automatic cold thaw adds unspecified latency to clone/fetch, exactly where task-start predictability matters. ([Imports](https://code.storage/docs/guides/imports))
- **Large-file fork breakage:** repository forks do not carry LFS object bytes, so a prepared source that uses LFS may produce an unusable task fork without an explicit migration path. ([Git LFS](https://code.storage/docs/guides/git-lfs))
- **Cross-repository drift:** multi-repository tasks have no documented atomic fork or shared snapshot identifier; the control plane must pin and record every repository SHA.
- **Credential leakage:** authenticated Git URLs contain JWTs. The run environment must prevent them from appearing in command logs, transcripts, process listings, exception telemetry, or remote configuration persisted beyond the run. The candidate’s docs show URL-embedded credentials but do not supply this surrounding redaction layer. ([Git operations](https://code.storage/docs/guides/git-operations))
- **Vendor and migration risk:** introducing an additional Git authority creates another sync path and failure mode. Keep the canonical upstream and a provider-neutral repository adapter until reliability, recovery, and export have been proven.
- **Young-surface risk:** beta labeling in one official SDK and simultaneous deprecated/current API references justify an evaluation posture rather than a hard dependency. ([Python package manifest](https://github.com/pierrecomputer/sdk/blob/main/packages/code-storage-python/pyproject.toml), [API reference](https://code.storage/docs/reference/api/overview))
- **Contract clarity risk:** the published SLA’s availability definition appears copied from a different service category. Obtain corrected, Git-specific uptime, exclusions, support, and credit terms before production reliance. ([SLA](https://code.storage/legal/sla))

## Suggested evaluation

Run a narrowly scoped spike before adding it to the roadmap:

1. Mirror a representative large repository and a three-repository project.
2. Measure p50/p95 create-ref, repository-fork, shallow-clone, fetch-after-idle, and delete times over several days.
3. Start two concurrent agents from the same base, exercise strict expected-SHA merges, and verify deterministic conflict reporting.
4. Kill the compute machine mid-task, recreate it from committed state, and record exactly what is and is not recovered.
5. Test a repository containing LFS assets and confirm the documented fork limitation.
6. Verify that credentials never appear in logs or transcripts and that expired URLs stop working.
7. Obtain written answers for pricing, quotas, regions, SLA, encryption, deletion, backup, incident history, and support.

Adopt only if it materially improves task startup or Git isolation while preserving the ability to fall back to an ordinary Git remote.
