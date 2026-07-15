# Fork-capable cloud-machine provider landscape

Research date: 2026-07-16

## Recommendation

Spike **Morph Cloud and E2B**.

- **Morph Cloud** is the architecture match: its public contract describes a
  snapshot as a full VM checkpoint (RAM, CPU, filesystem, and kernel), and its
  public pre-1.0 SDK exposes one-to-many branching from a running instance.
  Full Linux VMs, HTTP service exposure, SSH, remote-desktop templates,
  scale-to-zero, and low snapshot-storage cost line up with the target machine.
- **E2B** is the best independent control: its documented snapshot API creates
  one-to-many sandboxes with exact filesystem and memory state; its pause path
  has explicit latency, retention, billing, and reconnect semantics; and its
  official desktop template already uses Xvfb. Its main constraints are a
  Debian-only image pipeline, a listed 20+ GiB Pro disk allowance, dropped
  connections during snapshot, and a higher fleet price.

Keep **Daytona** as the alternate if either spike fails. It has the strongest
packaged GUI and recording surface, but the live-memory fork and hot-snapshot
SDK methods are currently marked experimental. Fly Machines, AWS Lambda
MicroVMs, Sprites, and Modal each miss the required arbitrary live-process,
one-to-many fork semantics.

This shortlist is for the next empirical spike, not the final provider lock.
Provider documentation does not prove that open SQLite handles, file watchers,
CDP sockets, tunnel processes, or Electron survive a fork correctly.

## What counts as a fork

The roadmap needs a reusable checkpoint of an already-running development
machine that can create multiple independent descendants. Same-machine
suspend/resume is useful for idle billing, but it is not a fork. Likewise, a
filesystem or volume clone does not preserve running processes.

| Provider | Live memory preserved | One-to-many from runtime state | Verdict |
| --- | --- | --- | --- |
| Morph Cloud | Yes: RAM, CPU, filesystem, and kernel | Yes: snapshot/branch starts independent instances | Shortlist |
| E2B | Yes: filesystem, processes, and memory | Yes: one snapshot can start many sandboxes | Shortlist |
| Daytona VM sandboxes | Yes | Yes, but the SDK surface is experimental | Alternate |
| Fly Machines | Yes for suspend/resume | No exposed reusable memory fork; clones use image/config and volume state | Disqualified |
| AWS Lambda MicroVMs | Yes for image launch and same-instance suspend | No arbitrary runtime checkpoint-to-many API | Disqualified |
| Sprites | No across sleep; checkpoints are filesystem-only | No | Disqualified |
| Modal Sandboxes | Alpha memory snapshots | Technically yes, but the source terminates and active/background exec constraints break the target workload | Disqualified |

## Hard-requirement fit

`Known` means the provider documents that capability. `Plausible` means the
documented Linux/runtime surface should permit it, but the exact workload is
not proven. `Blocked` means the provider contract rules out the required path.

| Provider | Headless Chromium | Electron + Xvfb | Capture and ship video | `cloudflared` + dev servers | Overall |
| --- | --- | --- | --- | --- | --- |
| Morph Cloud | Plausible: full Ubuntu VM and arbitrary packages | Plausible; official Devbox material shows remote-desktop templates, but not this Electron binary | Plausible with `ffmpeg`; no first-party recording contract found | Known for arbitrary HTTP services and outbound-capable full VMs; exact tunnel reconnect needs the spike | Pass to spike |
| E2B | Plausible: the desktop example proves Firefox, not local Chromium/CDP | Xvfb known; Electron itself plausible through Ubuntu packages | Plausible with `ffmpeg`; file download is documented | Known internet egress and public HTTP/WebSocket hosts per port; snapshot drops live connections | Pass to spike |
| Daytona VM | Unproven on the fork-capable VM class | Unproven: Computer Use proves Xvfb on a sandbox, not the fork-capable VM path | Unproven on the fork-capable VM path | Preview URLs are known; unrestricted egress depends on account tier | Alternate, experimental fork risk |
| Fly Machines | Plausible in an OCI-based Linux VM | Plausible | Plausible with `ffmpeg` | Known flexible ingress/egress | GUI passes, fork blocked |
| AWS Lambda MicroVMs | Plausible in a Docker-built Linux image | Plausible, not documented as a first-party workflow | Plausible; ship through HTTPS or configured egress | Egress can reach the internet, but first-party ingress is HTTPS and runtime lifetime is capped at 8 hours | Runtime fork blocked |
| Sprites | Plausible on full Ubuntu | Plausible while awake | Plausible while awake | Known URL, port proxy, and policy-controlled egress | Memory persistence/fork blocked |
| Modal | Known for Playwright/Chromium | Not documented | Not documented | Known sandbox networking | Snapshot semantics blocked |

## Provider findings

### Image and API pipeline

| Provider | Reproducible base | Promotion and rollback | API maturity and retention |
| --- | --- | --- | --- |
| Morph Cloud | Provider image IDs plus snapshot building and in-VM mutation; the cited surface does not establish a production-grade declarative image definition | Immutable snapshot IDs and lineage support rollback; rebuilding and relaunching the exact Chromium/Electron image is a spike gate | REST/OpenAPI plus a public pre-1.0 TypeScript SDK; rate limits, versioning commitment, and snapshot retention need confirmation |
| E2B | SDK template definition or a restricted Dockerfile converter over Debian-derived images | Named templates and snapshot IDs are reusable; templates suit reproducible bases and runtime snapshots suit rollback/fork | Documented TypeScript/Python SDK and REST lifecycle; paused sandboxes persist indefinitely, while snapshot retention/cost and deletion convergence need measurement |
| Daytona VM | Fork-capable VMs start from existing VM snapshots; declarative image builds apply to container sandboxes, not the VM path | VM snapshots and explicit fork lineage provide rollback | Hot snapshots and forks are experimental SDK methods; retention, API versioning, and ambiguous-result recovery need confirmation |
| Fly Machines | OCI image reference plus machine config; volumes hold persistent data | Image releases and volume snapshots/forks support cold rollback | Mature REST/CLI surface, but no reusable live-memory fork |
| AWS Lambda MicroVMs | Zip plus Dockerfile builds a versioned, initialized MicroVM image | Versioned images can launch many machines | Mature AWS API semantics, but runtime state cannot be promoted into a new reusable image |
| Sprites | Fixed Ubuntu environment mutated in place | Filesystem checkpoints support rollback | REST/SDK surface; checkpoints do not include live memory |
| Modal | Declarative Modal Images and container images | Image definitions and Alpha memory-snapshot IDs | Memory snapshots expire after seven days and have active-process restrictions |

### Morph Cloud

- The service terms define a snapshot as a full-state VM checkpoint covering
  RAM, CPU, filesystem, and kernel. A running instance can be snapshotted and
  multiple instances started from that snapshot. The TypeScript SDK exposes
  `instance.branch(count)`, pause-on-TTL, SSH, command execution, and HTTP
  service exposure.
- Devboxes are full virtual machines, can run container stacks, expose arbitrary
  web apps, provide SSH and tmux APIs, and scale to zero while preserving
  application and memory state. Public material also shows a noVNC desktop
  template, which makes Xvfb-class workloads credible but does not prove the
  exact Electron/video path.
- Pricing uses Morph Compute Units (MCUs): one MCU is the maximum of one
  vCPU-hour, 4 GiB RAM-hours, or 16 GiB disk-hours. Snapshot storage consumes
  one MCU per 5 TB-hour. The listed standard rate is $0.05/MCU.
- Main unknowns for the spike: measured branch-to-usable latency under the real
  workload; socket and clock behavior; fork identity; video capture; regional
  availability; and whether the provider's public benchmark restriction needs
  written permission before publishing measured results.

Sources: [Devboxes](https://cloud.morph.so/web/product/devboxes),
[pricing](https://cloud.morph.so/web/subscribe),
[technical terms](https://cloud.morph.so/web/legal/terms-of-service),
[TypeScript SDK](https://github.com/morph-labs/morph-typescript-sdk), and
[Devboxes OpenAPI](https://devbox.svc.cloud.morph.so/docs).

### E2B

- Runtime snapshots include filesystem and memory state. Snapshotting briefly
  pauses the source and then continues it; one snapshot can create many new
  sandboxes. WebSocket, PTY, and command streams are dropped during the
  snapshot, so Zuse must reconnect by identity rather than assume sockets
  survive.
- Pause/resume preserves processes and memory, paused sandboxes are retained
  indefinitely, and compute billing stops immediately. The documented
  performance is about four seconds to pause per GiB of RAM and about one second
  to resume.
- The official desktop template installs Ubuntu, XFCE, Xvfb, x11vnc, and noVNC.
  Custom templates can install Debian/Ubuntu packages and run Docker, but base
  images must be Debian-derived; multi-stage Dockerfiles, `VOLUME`, and
  `EXPOSE` are not supported by the template converter.
- Pro is $150/month plus usage, includes 100 concurrent sandboxes (add-ons raise
  this to 1,100), permits 24 hours of continuous runtime, and lists 20+ GiB
  disk. The current usage rates are $0.000014/vCPU-second and
  $0.0000045/GiB-second.

Sources: [snapshots](https://e2b.dev/docs/sandbox/snapshots),
[persistence](https://e2b.dev/docs/sandbox/persistence),
[desktop template](https://e2b.dev/docs/template/examples/desktop),
[network host API](https://e2b.dev/docs/sdk-reference/js-sdk/v2.14.1/sandbox),
[template base images](https://e2b.dev/docs/template/base-image),
[billing and limits](https://e2b.dev/docs/billing), and
[pricing](https://e2b.dev/pricing).

### Daytona

- Linux and Windows VM sandboxes support pause/resume with memory, hot snapshots
  with `includeMemory`, and direct forks that duplicate filesystem and memory
  into independent children with lineage. The SDK names for hot snapshot and
  fork are currently `_experimental_*`; container sandboxes do not preserve
  memory.
- Computer Use documents Xvfb, XFCE, x11vnc/noVNC, browser control, screenshots,
  and native screen recording/download. However, the cited material does not
  prove that this Computer Use stack runs on the fork-capable VM class; the
  combined VM-fork and GUI/video path remains unproven.
- Listed usage rates are $0.000014/vCPU-second,
  $0.0000045/GiB-second, and $0.00000003/GiB-second of disk after the first
  5 GiB. VM sizing, outbound networking, pause retention, and paused-state
  storage charges need account-level confirmation before adoption.

Sources: [sandbox pause, snapshots, and forks](https://www.daytona.io/docs/en/sandboxes/),
[Computer Use](https://www.daytona.io/docs/en/computer-use/),
[network limits](https://www.daytona.io/docs/en/network-limits/),
[limits](https://www.daytona.io/docs/limits), and
[pricing](https://www.daytona.io/pricing).

### Fly Machines

- Suspend uses a Firecracker snapshot of CPU registers, memory, and open file
  handles, with typical same-machine resume in hundreds of milliseconds.
- It is not a reusable memory-fork API. Machine cloning uses image/config and
  optionally a volume fork; a volume fork copies disk, not live process memory.
- Suspend has material constraints for this workload: Fly recommends at most
  2 GiB RAM, resume is not guaranteed, and snapshots can be lost across deploy,
  host migration, or maintenance. Full OCI Linux and flexible networking make
  the browser/desktop path plausible, but the roadmap's core fork requirement
  remains blocked.

Sources: [suspend/resume](https://fly.io/docs/reference/suspend-resume/),
[Machines API](https://fly.io/docs/machines/api/machines-resource/),
[machine clone](https://fly.io/docs/flyctl/machine-clone/),
[volumes](https://fly.io/docs/volumes/overview/), and
[pricing](https://fly.io/docs/about/pricing/).

### Credible peers

- **AWS Lambda MicroVMs:** a MicroVM image captures initialized disk, memory,
  and running processes and can launch many MicroVMs; a running MicroVM can also
  suspend/resume with memory and disk. However, AWS does not expose a way to
  turn arbitrary runtime state into a new reusable image or multiple forks.
  Each MicroVM lasts at most eight hours, and its first-party ingress is a
  dedicated HTTPS endpoint. Sources: [concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html),
  [lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html),
  [images and sizing](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html),
  and [pricing](https://aws.amazon.com/lambda/pricing/).
- **Sprites:** full Ubuntu, persistent ext4, fast wake, URLs, and cheap
  usage-based billing are attractive. Its detailed lifecycle documentation is
  explicit that RAM does not persist, processes stop on sleep, and checkpoints
  save the filesystem rather than process memory. Sources:
  [lifecycle](https://docs.sprites.dev/working-with-sprites/),
  [checkpoints](https://docs.sprites.dev/api/dev-latest/checkpoints/), and
  [pricing](https://sprites.dev/).
- **Modal Sandboxes:** Alpha memory snapshots can create clones, but taking one
  terminates the source; snapshots expire after seven days; active `exec`
  calls cannot be snapshotted; and background processes started by `exec` do
  not restore correctly. Sources:
  [sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots),
  [sandboxes](https://modal.com/docs/guide/sandboxes), and
  [pricing](https://modal.com/pricing).

## Overnight fleet cost model

This is a directional comparison, not a quote.

Assumptions:

- 100 ticket machines, all concurrent;
- 8 active hours per night for 30 nights = 24,000 machine-hours/month;
- 2 vCPU, 4 GiB RAM, and 20 GiB disk (or the nearest offered shape);
- no GPU; excludes egress, taxes, support, snapshot operations, and negotiated
  discounts;
- machines remain retained and paused for the other 16 hours per day = 48,000
  idle machine-hours/month. The table shows active compute plus known platform
  fees; Morph and Daytona retained-state charges must be measured and added.
  E2B documents paused sandboxes as free and excluded from running concurrency.

| Provider | Approximate active cost | Approximate monthly fleet cost | Caveat |
| --- | ---: | ---: | --- |
| Morph Cloud | 2 MCU/hour = $0.10/hour | ~$2,275 on Scale: $250 including 7,500 MCUs, then 40,500 MCUs at $0.05 | Assumes credits renew monthly and 100 Devboxes fit the listed 128 concurrency |
| E2B | $0.1656/hour | ~$4,124: $3,974 usage + $150 Pro | Excludes any snapshot/extra-storage charge; exactly 100 concurrency fits base Pro |
| Daytona | ~$0.165924/hour for the documented 2-vCPU/4-GiB/8-GiB VM | ~$3,982 active usage | A 100-machine fleet requires Tier 3 capacity/top-up; hot VM fork, egress tier, and retained-state charges need confirmation |
| Sprites | Up to ~$0.315/hour if both CPUs and all 4 GiB are continuously used | Up to ~$7,560 plus storage | Bills measured CPU and resident memory, so realistic bursty use may be much lower; no memory fork |
| Fly Machines | Shape- and region-dependent | Roughly ~$1,000 for one-third-month runtime plus 20 GiB volumes, before network | Cheapest rough fallback, but it buys cold disk clones rather than the required live fork |
| AWS Lambda MicroVMs | Published baseline CPU/RAM rates | ~$6,053 before snapshot reads/storage and transfer | Eight-hour maximum includes suspended time, leaving no margin for an eight-hour active run; no runtime fork |
| Modal | Published Sandbox CPU/RAM rates | ~$5,711 before plan fees/credits | Alpha snapshot constraints disqualify the workload |

All figures are derived from public prices on the research date and can change.
Morph's estimate assumes monthly credit renewal; its retained snapshot charge
depends on stored bytes. E2B's figure excludes snapshot or storage beyond the
listed Pro allowance. Daytona's 8 GiB VM is below the target 20 GiB disk, so its
price is not a like-for-like capacity match.

## Spike protocol for the shortlist

Run the same harness on Morph Cloud and E2B:

1. Provision the closest available 2 vCPU / 4 GiB / 20 GiB Ubuntu machine.
2. Start `zuse serve`, a watched dev server, a SQLite-backed workload with open
   handles, headless Chromium over CDP, Electron under Xvfb with a remote
   debugging port, and `cloudflared`.
3. Establish an active PTY, WebSocket, file watcher, database write loop, and
   browser session. Record process IDs, environment identity, clocks, sockets,
   and database counters.
4. Create a reusable snapshot and launch 10 descendants concurrently for the
   functional pass. Then run 100 machines or obtain written 100-machine capacity
   assurance and run the largest permitted saturation test. Measure source
   pause, snapshot completion, fork-to-command, fork-to-healthy, and fork-to-CDP
   latency across enough warm and cold repetitions to calculate p50/p95 and an
   error rate. Test creation-rate throttling, partial fleet creation, quota
   headroom, and source-plus-descendant accounting.
5. Verify that processes and memory survived; filesystem and SQLite histories
   diverge independently; tunnel and relay identities re-key; dropped
   connections recover; and watchers still observe changes.
6. Record the intended 90-second evidence artifact from Xvfb at 1440x900,
   24 fps, H.264; ship it through the provider API or an outbound upload. Record
   sustained CPU/RAM/disk use, artifact integrity, upload time, egress cost,
   retry/resume behavior, and recovery after tunnel or capture-process failure.
7. Pause for four hours, resume, repeat health checks, and inspect the actual
   bill. Repeat after the longest documented idle interval relevant to an
   overnight run.
8. Fail each dependency once: provider API timeout, snapshot during a write,
   killed tunnel, expired credential, lost WebSocket, and failed resume. Prove
   retries are idempotent or reconcilable through list/lineage APIs: ambiguous
   results cannot leave duplicate descendants or orphaned billable machines,
   and a partial fleet can be discovered and completely deleted. Compare API
   versioning, rate limits, pagination, error shapes, and deletion convergence.

Choose the provider only after the same result sheet exists for both. The
selection gates are: all four hard requirements work; no database corruption;
identity can be safely re-keyed; source interruption is p95 <= 5 seconds,
fork-to-command is p95 <= 5 seconds, fork-to-healthy is p95 <= 15 seconds,
resume-to-healthy is p95 <= 10 seconds, lifecycle-operation error rate is < 1%,
and the measured monthly model stays within the fleet cap. If no provider meets
these provisional thresholds, revise the roadmap promise before locking one.
