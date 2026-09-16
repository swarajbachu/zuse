# Resume latency investigation

The target is five seconds from user send to session acceptance on E2B and the
lowest safe latency on Box. It is a target, not a measured result of this change.

## What the existing measurements establish

The disposable E2B server-health benchmark took 2.23, 2.04, and 2.00 seconds.
It omitted production authentication, runtime updates, and message delivery.
Two production API tests observed message settlement at 22.710 and 19.162 seconds.
They polled both workspace status and the conversation ledger sequentially from
the Mac, so these are upper bounds on receipt, not exact agent-start timings.
The first test still observed a pending message at 18.459 seconds; the second at
13.935 seconds. Both entered runtime provisioning after resume. This proves a
restart happened, but does not distinguish warm reconnect failure from a required
runtime capability upgrade. Do not subtract an assumed model latency.

Box's earlier measurements are in [the benchmark report](benchmarks/2026-09-16-box-resume.md).
They are server-health measurements and cannot be compared to those API totals.

## The path and its restart boundaries

1. The public API authenticates, authorizes billing, seals and durably saves the
   message plus a resume command. The desktop also has a durable command mailbox;
   public API and desktop delivery must both be tested.
2. Reconciliation claims the workspace and selects its recorded provider.
3. E2B preserves processes. A compatible retained runtime is woken and gets a
   reconnect grace window. Box does not preserve processes and must start Zuse.
4. An explicit restart, old mailbox protocol, required generation fence, missing
   reconnect, or stalled consumer can cause a fenced runtime replacement.
5. Replacement inspects/wakes compute, prepares the signing key and repository
   marker, authorizes a fresh boot generation, applies network policy, then starts
   the runtime updater and Zuse. The updater already skips installation when the
   signed manifest matches the installed version; it still checks the manifest.
6. Runtime startup creates keys, exchanges the boot token, configures provider
   authentication, reconnects its gateway, and recovers the chat/session. The
   durable consumer can work independently of the UI gateway.
7. The consumer receives/leases a command, materializes any attachments, submits
   the message to the session, and acknowledges delivery. Agent/model work follows;
   session acceptance does not prove the external model has received the request.

The E2B grace deadline was calculated before provider resume, consuming some or
all of its 500 ms budget while waking the VM. The grace is now 12 seconds,
starting after provider resume completes.
The mailbox's first read now happens immediately; subsequent cycles retain their
one-second delay and remain serialized.

Box cannot avoid process startup by using systemd: its disk restore loses RAM.
The adapter prepares persisted paths, but Box firewall setup and waits have been
removed. See [Box open networking](box-open-networking.md) for deployment order
and the remaining measured delays.
Fresh boot authorization must precede startup; consumed boot tokens cannot be
replayed by an automatically restarting service.

## Timestamp collection

API and runtime emit `[cloud-timing]` records correlated by workspace, command or
message ID, and runtime generation where available. No prompt, token, request body,
or error payload is recorded. Operation records contain start/end epoch timestamps,
local monotonic duration, and success/failure. Runtime shell records include update
start/end and exec boundaries in `/var/lib/zuse/workspace/runtime.log`.

| Records | What they isolate |
| --- | --- |
| `message.request-authorized`, `message.persisted` | Authorized API request through durable save |
| `provider.resume`, `provider.inspect` | Adapter wake and inspection; Box wake includes restore preparation |
| `runtime.restart-decision` | Why the reconciler chose replacement, rather than assuming all resumes restart |
| `runtime.write-file`, `provider.network`, `runtime.replace` | Remote preparation, egress barrier, process replacement |
| `runtime.shell-start`, `runtime.update-start/end`, `runtime.exec` | Updater check/install and executable handoff |
| `runtime.initializing`, `runtime.bootstrap`, `runtime.bootstrap-received` | Runtime initialization and boot exchange |
| `runtime.credentials-ready`, `runtime.bootstrap-ack`, `runtime.gateway-open` | Authentication preparation and gateway reconnect |
| `runtime.mailbox-starting`, `message.leased` / `message.received` | Queue consumer readiness and receipt (mailbox / public API) |
| `message.session-accept`, `message.delivery-ack` / `message.mailbox-ack` | Local acceptance and API acknowledgement |

Public API message rows now expose optional `deliveredAt`, from the existing
persisted API acknowledgement timestamp. Historical/undelivered rows can omit it.
`deliveredAt - createdAt` measures server-side delivery latency without poll cadence
or model completion. It excludes client-to-API delay and includes runtime-to-API
acknowledgement latency. Epoch timestamps across VM/API/Mac can have clock skew;
use local operation durations for phase costs, not cross-host subtraction alone.

These records do not yet measure UI click-to-request, each internal DB operation,
external model receipt, or first token. Add those boundaries before claiming a
complete user-visible first-token metric. Avoid interpreting `agentStartedAt` from
existing workspace projections as external model receipt.

## Next live experiment

Deploy the API instrumentation and publish the matching signed runtime to staging;
ensure both provider account images can load that runtime. Merely deploying the
API will not instrument already paused runtimes. Upgrade once, then pause the same
workspace for repeated warm-resume tests. Record runtime versions and restart reason.

For each provider, use a disposable workspace, wait for the initial turn to settle,
pause, then send a unique short message. Collect client send time, API `createdAt`
and `deliveredAt`, runtime timing records, and completion separately. Include short
and long pauses (expired sockets/credentials), unchanged vs updated runtimes, and
attachments. Verify one accepted turn per message and delete the test workspace.

Prioritize E2B reconnect/capability failures before changing updater behavior. If a
preserved consumer can acknowledge the queue promptly, avoid killing it merely
because the disposable UI gateway has not reconnected. Any such change must retain
runtime fencing, compatibility upgrades and bounded recovery for dead processes.
Next, consider gateway wake notifications for the existing serialized mailbox
consumer, retaining periodic recovery reads. For Box, separate VM readiness and
command dispatch from file preparation; measure updater and auth costs before
attempting caching or concurrency changes.
