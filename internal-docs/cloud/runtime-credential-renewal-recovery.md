# Runtime credential renewal recovery

## Incident and verification limits

On 2026-10-29 an existing boxd workspace remained reachable while its Zuse
runtime logged `workspace_runtime_rejected`. Its durable identity contained a
pending renewal, and a desktop message remained at “Connecting to cloud
runtime…” without reaching the original session. In-place runtime recovery
established a new generation and delivered that existing message. The database
passed `PRAGMA quick_check` before and after recovery.

The retained logs do not establish the original renewal failure's exact trigger.
The regression below reproduces a concrete cancellation race that can strand a
live runtime with a stale bearer; it is not proof that this race caused that
particular incident.

## Reproduce the cancellation race

From the repository root:

```sh
bunx vitest run apps/server/test/unit/cloud-runtime-renewal-replay.test.ts
```

The interruption test uses the real identity file, renewal function, refresh
serialization gate, and mailbox lease request. No production fault switch or
real credentials are needed:

1. Enroll a temporary identity with a still-unexpired old bearer.
2. Return a successful rotation response containing a new bearer.
3. Pause the persistence callback immediately after the real identity write
   commits the new bearer and clears `pendingRenewalId`.
4. Interrupt the renewal fiber, then release the persistence callback.
5. Enter the shared refresh gate and attempt an authorized mailbox lease.

Before the fix, cancellation leaves the live bearer old while the durable
identity is new and no renewal is pending. The refresh gate sees an unexpired
credential and skips renewal; the mailbox rejects it. The regression fails
without waiting for an actual credential lifetime or a day-long outage.

After the fix, the durable commit and live bearer/expiry update finish together
before cancellation completes. The cached gateway bearer is invalidated too.
The mailbox uses the new bearer without another rotation. Network requests and
retry sleeps remain interruptible; only the local commit is protected.

## Related regression coverage

Run the focused recovery suite:

```sh
bunx vitest run \
  apps/server/test/unit/cloud-runtime-renewal-replay.test.ts \
  apps/server/test/unit/cloud-runtime-identity.test.ts \
  apps/server/test/unit/cloud-runtime-wake.test.ts \
  apps/server/test/unit/cloud-runtime-wake-integration.test.ts \
  apps/server/test/unit/cloud-workspace-runtime.test.ts
```

- Lost renewal responses replay the same request ID, bearer and signing key,
  both in the same process and after reopening the persisted identity.
- Expired credentials and outages longer than their lifetime recover without
  assuming that expiry means ownership revocation.
- Concurrent gateway/mailbox recovery shares one serialized renewal path.
- Wake handling resets control-plane sockets without cancelling unrelated
  provider streams or a command already being applied.
- Mailbox receipts protect accepted messages against replay, and confirmed
  generation fences stop the old executor.

## Isolated live verification before rollout

Use a disposable workspace containing a known chat, session, queued message and
repository edit. Never fault-inject into a user's active workspace. Follow
[runtime data recovery](runtime-data-recovery.md) for storage checks and backups.

Drop a renewal response after the API commits it, then reconnect the retained
runtime. Repeat with a runtime restart and with suspend/resume past credential
expiry. For the narrow commit/cancellation window, use the deterministic test
above instead of relying on VM timing.

Verify the sandbox, chat and session IDs and repository edit survive; the
pending renewal clears; the gateway reconnects; the original waiting message
executes exactly once; and the client receives new tool/reply output. An online
machine or successful bootstrap alone does not pass this check. Confirmed
revocation must still stop execution. Persistent ambiguous authorization
failures remain distinct from confirmed fencing; this fix does not replace
that policy or guarantee recovery from every source of rejected credentials.

Publishing source changes does not update retained runtime binaries. Verify a
signed runtime rollout separately; this regression suite is local evidence.
