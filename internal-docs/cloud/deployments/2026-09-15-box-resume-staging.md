# Box cold-resume recovery

Deployed staging through the Mac bridge at 2026-09-15T10:26:50Z, Worker version
`9bf80940-c4bd-43fe-b0e2-2a1ed13fd30d` at 100% traffic. Both staging API domains
passed routing checks. Production was not changed.

Box cold boots preserve files but not processes. Two restart issues were fixed:

- Legacy process cleanup patterns appeared literally in their own shell command,
  allowing pkill to kill the replacement shell. Patterns now match literal
  command markers without matching the cleanup command itself.
- PID files persist across cold boots. Tagged process records now include the
  kernel boot ID; old or mismatched records cannot kill a reused PID. Legacy
  runtime discovery remains available through the narrow command markers.

The mailbox wake path now immediately starts a fenced runtime replacement for
providers that lose processes. E2B still receives its warm reconnect grace.

Validation passed: 77 provider tests, 468 API tests, 50 runtime/command-receipt
checks, provider/API type checks, scoped Biome, and a real Box lifecycle test
including runtime replacement after a cold resume. The optional PostgreSQL
integration test was skipped without its test database URL. E2B unit and warm
resume regression coverage passed; no live E2B test was run in this task.

Fetched origin/main at 2e88e551. It is already an ancestor of this branch.
Mailbox, gateway, attachment, and upload implementation files match main.
The API suite includes attachment upload/download and mailbox delivery tests;
this is not a claim of a fresh desktop upload UI smoke test.

The reported workspace remained on its original Box and retained its files.
An expiring authenticated staging-only diagnostic Worker inspected lifecycle
metadata through the existing Hyperdrive binding. After deployment it retried
only the reported failed workspace, guarded by workspace ID, Box ID, provider,
desired state, and runtime-connection-timeout status. It retained the runtime
session recovery flag and queued the normal reconciler rather than replacing
the sandbox. The workspace subsequently reported ready/online/agent-running
with runtime generation 6, and its loopback listener was verified.
The temporary diagnostic Worker and local credential copies were removed.
