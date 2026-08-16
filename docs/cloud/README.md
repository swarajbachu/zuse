# Zuse Cloud

Zuse Cloud runs a Zuse workspace in an isolated provider sandbox while the
desktop or mobile client remains a disposable viewer and controller. Closing
the app, sleeping a laptop, or changing networks does not own or terminate an
accepted agent turn.

The current private beta uses E2B as its sandbox provider. The product model is
provider-neutral: E2B is an adapter, not a second chat type. Local, SSH,
pairing, and user-managed remote environments keep their existing paths.

## System invariants

- The workspace runtime's SQLite database is the only writable authority for
  chats, sessions, messages, turns, queues, and command receipts.
- Relay is a control plane. It owns identity, lifecycle, tickets, catalog
  metadata, billing, and encrypted transcript-checkpoint metadata.
- The workspace Durable Object forwards opaque live frames. It is not a chat
  database, command queue, or replay buffer.
- R2 stores encrypted, read-only transcript projections. It cannot accept a
  command or become transcript authority.
- Client persistence supplies the immediate offline view. Reconnecting never
  clears valid cached data.
- Files, Git, and terminals remain environment resources; they are not copied
  into the transcript.
- Every resource identity includes its environment. Old generations and
  regressing cursors are rejected before they reach UI state.

## Documentation map

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Components, authority boundaries, control and data planes |
| [Lifecycle](lifecycle.md) | Project preparation, workspace states, pause, archive, and deletion |
| [Realtime and storage](realtime-and-storage.md) | Offline opening, R2 catch-up, live synchronization, and large histories |
| [Security](security.md) | Identity, private-beta authorization, credentials, encryption, and isolation |
| [Operations](operations.md) | Releases, environments, migrations, monitoring, incidents, and smoke tests |
| [User guide](user-guide.md) | Setup, chat behavior, local/cloud terminals, archive, billing, and common failures |

These focused documents explain the cloud product. The following files remain
the authoritative operator or subsystem references and should be linked rather
than copied:

- [Realtime runtime architecture](../architecture/realtime-runtime.md)
- [Unified computer model](../specs/unified-computers.md)
- [Cloud sandbox template](../../infra/cloud-sandboxes/README.md)
- [Cloud billing operations](../../infra/relay/CLOUD_BILLING.md)
- [Private beta production runbook](../../infra/relay/PRIVATE_BETA_PRODUCTION.md)
- [Relay package reference](../../infra/relay/README.md)

## Current product behavior

Zuse Cloud is an invite-only beta. WorkOS authenticates the account and Relay
evaluates the `zuse-cloud-beta-access` PostHog flag using that verified account
identity. An invitation controls hosted cloud operations only; it does not gate
local, SSH, pairing, or normal remote-server use.

A Cloud Workspace subscription is $40 per month, includes $35 of attributable
sandbox-provider compute cost, and bills additional provider cost plus 5%, up
to the user's overage cap. The default pre-tax cap is $25. See the billing
runbook for the exact ledger and rollout rules.
