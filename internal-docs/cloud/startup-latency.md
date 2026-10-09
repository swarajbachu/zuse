# Cloud startup latency experiment

The target is p95 below three seconds from user action to gateway connected and
repository ready. Measure first agent command acceptance separately; moving auth
off the gateway path must not hide an agent waiting for credentials.

## September 29 implementation

The Boxd adapter already creates machines with `machines.create({ fromSnapshot })`.
Its provider-neutral `fork` name does not select a different Boxd operation.
Older images start a new runtime after restoring the machine. Prepared Boxd
images now activate through their preserved launch service and warm code cache.

This first implementation changes the credential path:

- Authority initialization records a digest of installed bootstrap sources and
  the storage incarnation. Unchanged authorities skip uploads and CLI checks.
  Missing, interrupted, or outdated installs run the existing initializer.
- An authority-owned HTTP service listens on port 47839 behind the provider's
  HTTPS endpoint. A random bearer is written with mode 0600 to
  `~/.zuse/cloud-auth/grant-service.json`. The API reads it through the provider
  channel; never log or expose it to clients. It rotates when the service starts.
- The service imports immutable, content-addressed grant modules. The CLI and
  HTTP service share the grant implementation, encryption, storage checks, and
  request fingerprint cache. OS refresh locks also serialize with older workers.
  Grants do not upload operation files or launch a fresh Node process.
- A missing service is started under an exclusive OS lock. Concurrent repair
  attempts do not replace a running service or interrupt refreshes. Requests
  have deadlines and bounded concurrency. A retry keeps its original request ID.
- Codex grant initialization runs in a scoped background task. The resolver is
  installed first so agent consumers share its pending request. Closing the
  runtime cancels grant requests and rejects late results. Gateway/repository
  readiness no longer depends on the Codex grant. Provider auth failures remain
  visible to the agent requiring that provider.

New timing stages: `auth.authority.prepare`, `auth.grant`, and
`runtime.codex-auth`. Correlate these with allocation, gateway connection, and
message acceptance; do not add cumulative milestone timestamps together.

## Local evidence and deployment limits

Subsequent [live Boxd verification](validation/2026-09-29-boxd-startup.md) measured
real proxy grants and warm-runtime snapshot restores. It also found first-use
TLS readiness delays; service retries now have a 30-second total deadline.

An isolated local benchmark used synthetic Cursor credentials and 20 fresh grants
per transport after warmup. The old CLI handler measured p50 37.98 ms / p95
51.99 ms; the persistent HTTP handler measured p50 7.82 ms / p95 9.46 ms.
This measures local handler execution only, without provider API, proxy, database,
allocation, upstream refresh, or desktop latency. It does not establish a
three-second cloud startup or predict the reduction in the observed 4.3-second
credential phase.

Deploy the compatible API and runtime before measuring live. The first grant
also installs updated tooling and starts the service; report that separately
from subsequent grants. Verify authority wake, service restart, concurrent
workspaces, and expired-token refresh. New runtime images affect new workspaces;
existing workspace state must remain intact under ADR 0002.

## Boxd prepared runtime

Only Boxd implements the optional `prepareWorkspaceSnapshot` and
`startWorkspaceRuntime` adapter capabilities. After account-image sanitization,
the builder populates Node's compile cache and loads a launch service in a clean environment,
waits for its local
Unix-socket handshake, and captures that process in the snapshot. This preloads
the application module graph; it deliberately does not acquire service layers,
open a workspace database, enroll, generate keys, or connect to a gateway.

On restore, the adapter skips CLI priming when the prepared listener answers.
One activation request carries the new workspace identity, generation, epoch,
boot token, environment, and bootstrap-script hashes. Matching scripts skip
uploads and the separate CLI priming pass. The existing bootstrap prepares SSH/GitHub
identity; the launcher starts a **fresh Node process** from the warm compile/page cache
and starts repository setup concurrently. Reusing the restored application
process itself was rejected after live tests produced identical RSA and Ed25519
keys in separate clones. OpenSSL/UUID state must not cross workspace assignments.
The preserved process only coordinates activation; it does not serve sessions. Runtime enrollment and gateway events
remain the readiness authority; activation acknowledgement alone is not ready.

The socket is restricted to the runtime user. A process claims one identity
before asynchronous work, accepts identical retries, and rejects conflicting
activations. Incompatible idle images retire before cold replacement. The
prepared process uses the existing `zuse-runtime` service tag so fenced recovery
stops the complete process tree. Image preparation rejects existing runtime data
and active workspaces. No existing workspace database is moved or reset.

Older bundles, missing prepared processes, and resize-induced cold boots retain
the ordinary startup path. Other providers keep their existing behavior. Deploy
the compatible API and signed runtime, then rebuild Boxd account images to use
the capability; this code does not upgrade existing snapshots automatically.
Avoiding resize reboots and verifying full control-plane/session readiness remain
necessary for a p95 three-second target.


## On-demand Boxd startup

Machines are still created for each requested workspace. The interactive path
is create → arm timeout → persist the workspace fence → activate. Activation
also proves guest readiness, removing separate probes on same-size restores.
Cold/older images and resized machines keep the necessary cold checks. Boxd's
name-idempotent create handles lost-response adoption, so fresh starts omit the
preflight lookup and duplicate timeout renewal. Existing resume paths retain
explicit recovery and timeout renewal.

Boxd grants contact the local authority service through its authenticated machine
control channel, without exporting its bearer to the API or provisioning a public
HTTPS route. Other providers keep the HTTPS transport. Certificate delays are
therefore absent from the Boxd grant path; missing services still use the locked
repair path. The first authority initialization remains separate from warm grants.
