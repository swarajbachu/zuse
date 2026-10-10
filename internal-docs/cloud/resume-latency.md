# Resume latency investigation

Current startup and recovery behavior is defined in the
[architecture plan](runtime-architecture-plan.md); the
[validation record](runtime-architecture-validation.md) contains current release
measurements and remaining gates. Boxd targets under five seconds for ordinary
startup preparation, with repository work and total agent receipt reported
separately. Boat and E2B share the reliability contract and report their actual
provider-specific timings.

The older measurements below are historical evidence, not current performance
claims or instructions for the updated runtime.

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

## Current path

Preserved-process wake resumes the same machine and renews access if needed.
Confirmed process loss starts the compatible installed release on the original
disk under the shared writer fence. Neither path installs software or checks the
latest channel. Signed artifact installation is explicit release maintenance.

A new workspace opens the authenticated runtime connection and accepts durable
prompts before repository/account preparation completes. The execution gate
releases provider startup and sends only after those prerequisites are ready.
See [lifecycle](lifecycle.md) for the canonical sequence.

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

## Further validation

Use the [shared validation gates](runtime-architecture-validation.md), including
matching deployed API/runtime versions, actual message receipt, unchanged
conversation/storage identity, expired-token wake, and interrupted update tests.
Provider restore, local health, gateway handshake, domain acceptance, and first
model output are different milestones; report each without hiding time spent
between them.
