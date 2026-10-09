# Boxd startup and credential verification — September 29, 2026

Verified against organization `zuse`, base snapshot `zuse-base-v20260927-1`
(`snap_1192f0047110490a8a38a1891f8993c1`), at its captured size of 2 vCPU / 8 GiB.
All machines were isolated, disposable test resources. No existing workspace,
account credentials, production API, or published image was modified.

## Measurements

| Operation | Observed duration |
| --- | --- |
| Base snapshot allocation through the current adapter, seven samples | 2.20–3.28 s |
| Initial three samples: SDK create call alone | 0.19–0.50 s |
| Initial three samples: allocation's CLI priming command | 1.61–1.80 s |
| Start installed runtime and observe protected local HTTP, three samples | 1.38–1.75 s |
| Clean warm-runtime snapshot: create, SDK readiness, protected local HTTP, three samples | 0.535 / 0.622 / 0.595 s |
| Current adapter allocating from that warm snapshot, one sample | 2.174 s |
| Adapter pause / resume, one sample | 0.022 / 0.338 s |
| Persistent auth service over established HTTPS, twenty grants | 8–33 ms |
| Persistent grant plus adapter descriptor/endpoint lookups, six samples | 0.371–0.489 s |
| Previous request-file / process / result-file transport, six samples | 1.041–1.136 s |
| Actual updated `issueProviderGrant` function, three warm calls | 0.661 / 0.662 / 0.676 s |
| First `issueProviderGrant`, including installation and proxy readiness | 16.286 s |

The clean warm snapshot contained the installed Zuse server already running.
Every restore returned protected HTTP 401 and retained the server's systemd PID.
The measurement used guest execution to check local HTTP, so it includes SDK
control-channel readiness and probe cost. It does not include account enrollment,
workspace assignment, gateway attachment, or agent launch.

Do not interpret three fast samples as a p95 guarantee. An earlier snapshot
containing both the server and synthetic auth service took 4.209 s to reach
protected HTTP; its SDK exec-readiness probe alone took 2.798 s. Another restore
failed a single immediate HTTP check. The final clean-snapshot run used bounded
HTTP polling. These experiments do not isolate the cause of that variation.

## Credential verification

The persistent service ran on real Boxd machines with synthetic Cursor API-key
credentials. HTTPS requests without its bearer were rejected. Successful grants
were decrypted with the test recipient's private key and checked against the
synthetic secret; no user provider credentials were used.

The actual API grant function was also exercised using the real Boxd adapter
and an in-memory control-plane store. It successfully installed the authority,
started its service, issued a sealed grant, and reused the installed tooling for
subsequent grants. Production database and Worker-region latency are not included.
All measurements originated in this cloud workspace, not the desktop.

Fresh proxy endpoints initially failed TLS with `ERR_SSL_TLSV1_ALERT_ACCESS_DENIED`
for approximately 11–12 retries at one-second intervals. The endpoint subsequently
presented a valid wildcard certificate, independently verified with OpenSSL.
Certificate verification was never disabled. The first API grant spent 13.13 s
in transport/service readiness and 16.286 s overall.

This exposed an insufficient startup retry window in the new service transport.
It now retries the same request ID within a 30-second total deadline, covering
first-use certificate issuance without replacing the running daemon. A regression
test checks recovery after five consecutive failed requests. The authority
preparation timing was also corrected to include provisioning/initialization.

## Checks and cleanup

- Existing Boxd live lifecycle suite passed in 39.82 seconds of test execution:
  allocation, file persistence, HTTPS/WebSocket proxying, installed runtime HTTP,
  SSH upgrade handling, pause/resume, process replacement, snapshot and restore.
- Updated auth unit suites: 17 tests passed. Scoped Biome and API types passed.
- Every test machine and snapshot was deleted, including failed probe attempts.
  A final provider inventory found no remaining resources for the verification
  run IDs or auth API test prefix. The temporary API-key file was removed.
- The production API/runtime was not deployed. Full authenticated
  click-to-agent-ready latency remains unverified.

## Consequences for the three-second target

The fast clean-snapshot results support continuing with a preinitialized runtime
that awaits workspace assignment. Current allocation still spends roughly
1.6–1.8 seconds priming the CLI, even when useful processes are already restored.
Removing that work requires a prepared-image capability and retaining the cold
boot/older-image fallback, rather than deleting it for every existing snapshot.

Prepare the auth service and its HTTPS endpoint during account setup, before
starting a chat. Its first-use certificate delay cannot fit inside three seconds.
Then measure repeated workspace activation, gateway attachment, and first agent
command acceptance with the real control plane, including restore tail latency.


## Initial in-process activation experiment (rejected)

A locally built current runtime bundle was installed only on disposable Boxd
machines. The actual adapter prepared and captured an idle runtime, restored
three independent machines, and activated each with the production bootstrap
and repository scripts. A localhost observer recorded the first enrollment
request and returned 503 deliberately: no production enrollment, account
credential exchange, gateway attachment, or agent launch was claimed.

| Sample | Adapter allocation | Activation RPC | Allocation through observed enrollment request |
| --- | ---: | ---: | ---: |
| 1 | 784 ms | 278 ms | 1,693 ms |
| 2 | 827 ms | 283 ms | 1,869 ms |
| 3 | 736 ms | 236 ms | 1,844 ms |

Preparation took 3,355 ms and snapshot capture 8,150 ms, both paid at image-build
time. An earlier independent restore reached enrollment in 2,589 ms. These are
small samples from this runner, not production p95 measurements.

The runtime PID was unchanged across restore and activation. The source had no
workspace database or enrollment request. Clones created their own database and completed repository setup. The original
combined key fingerprint check was insufficient: SSH keys differed, masking
repeated application keys. A subsequent per-key check found identical RSA and
Ed25519 keys in two independent restores. The in-process activation design was
therefore rejected; these timings do not describe the final implementation. All disposable
machines and snapshots, including failed fixture attempts, were deleted.
Production API/runtime and shared base snapshots were left unchanged.

## Fresh-process activation (implemented)

The launch service now starts a fresh Node process with the snapshot's warm
page cache and prepopulated `NODE_COMPILE_CACHE`. The restored application's
OpenSSL/UUID state is never used for workspace keys or sessions. The launch
service keeps the idempotency handshake and existing systemd lifecycle tag.

| Sample | Adapter allocation | Activation RPC | Allocation through observed enrollment request |
| --- | ---: | ---: | ---: |
| 1 | 5,314 ms | 189 ms | 7,307 ms |
| 2 | 780 ms | 188 ms | 2,610 ms |
| 3 | 1,740 ms | 189 ms | 3,544 ms |

Each individual RSA, Ed25519 and SSH public-key fingerprint differed across all
three clones. Fresh runtime processes and databases were also verified. Snapshot
capture in this run took 87.7 seconds. These aggregate measurements show substantial
allocation-path tail latency (including our own checks): the three-second target is **not consistently achieved**,
even before real enrollment/gateway/agent work. Machines must continue to be created on demand. Separate raw create latency
from our readiness/setup work before attributing the aggregate to Boxd; reduce
redundant work on that path. Cloning an enrolled application's crypto state is
not safe.

A repeatable live regression is in
`packages/sandbox-providers/test/live/boxd-prepared.live.test.ts`. Build the cloud
bundle, then run that file with `BOXD_API_KEY`, `BOXD_ORG`,
`BOXD_TEMPLATE_SNAPSHOT`, and `BOXD_PREPARED_RUNTIME_BUNDLE` configured. It uploads
only to disposable machines, compares each key independently, and cleans up its
machines and snapshots. The endpoint is a local observer returning 503, so this
test deliberately does not claim authenticated session readiness.

Checks: API suite 549 passed (four existing skips); focused provider, prepared
protocol, runtime-auth and reconciler suites 291 passed; runtime-asset suite 21
passed with `/usr/bin` before the host's GitHub shim in PATH. API, server and utils
type checks passed. Provider types passed with explicit Node/Vitest types; its
default type command still reports existing Bun `fetch.preconnect` conflicts in
Box/E2B files. Scoped Biome, shell syntax, and the cloud runtime bundle build
passed. The bundle retains its existing optional Cursor `bun:sqlite` warning.

The committed live regression then passed independently (45.42 seconds of test
execution), including all three per-key uniqueness assertions and resource
cleanup. The temporary local API-key file and generated bundle were removed.


## On-demand round-trip reduction

The Boxd workspace path now creates the machine and arms its idle timeout,
then confirms readiness with the activation request itself. Same-size creates
skip SDK readiness polling, a separate systemd preparation command and the
prepared-process probe/CLI prime. Resize reboots retain their boot-ID fence.
Missing/incompatible launch services take the cold path; transient activation
requests retry the same identity within an eight-second total deadline.

Fresh Boxd starts also skip the preliminary label lookup (create already handles
ALREADY_EXISTS) and duplicate idle-timeout extension. Paused machines adopted
after a lost create response are explicitly woken; resume paths retain recovery.
Other providers retain their previous allocation behavior. No machine pool was
introduced.

Boxd authority grants now use one authenticated control-channel exec to read the
service descriptor and contact localhost. The bearer stays in the guest. Public
proxy resolution and certificate issuance are removed from the Boxd grant path.
The live API grant function measured 4,338 ms for initial tool/service setup
(previously 16,286 ms), then 473 / 379 / 379 ms for subsequent grants (previously
roughly 660–680 ms). These runs use a real Boxd authority and an in-memory API
store with synthetic provider credentials; they are not full session timings.

The shortened allocation/activation path was then verified on three fresh clones:

| Sample | Create + idle timeout | Activation/readiness RPC | Through enrollment request |
| --- | ---: | ---: | ---: |
| 1 | 226 ms | 3,584 ms | 5,997 ms |
| 2 | 422 ms | 458 ms | 2,209 ms |
| 3 | 194 ms | 296 ms | 3,809 ms |

All per-key isolation assertions and database/repository checks passed. This
separates allocation from readiness: the first clone's delay occurred inside
activation, after create returned. Some former allocation time necessarily moves
to activation; removing checks does not eliminate guest readiness delays. Fresh
runtime initialization also remains measurable after the activation acknowledgement.
No claim of consistent sub-three-second authenticated session startup is made.
All test machines/snapshots were deleted. Targeted behavior suites: 260 passed.

## October 3 rebase compatibility

Rebased onto `e76c29c9` from main. Upstream native-machine fork recovery and
signed-runtime installation remain intact. When a signed runtime manifest is
configured, startup retains the updater command and replaces an idle prepared
launcher through the cold fallback. Deferred readiness is used only for the
compatible prepared activation path. Authority initialization retains main's
public/private-key checks and Grok installation validation; its version digest
also covers the grant-service sources. Earlier latency figures predate this
integration and have not been remeasured on the rebased branch.
