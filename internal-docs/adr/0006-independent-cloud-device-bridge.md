# Independent cloud device access

Status: Implemented; API rollout required before updated clients can connect.

Remote access and cloud device access are separate capabilities. Signing into a desktop enrolls a cloud-command device; it does not publish an environment, enable LAN access, provision a managed tunnel, or enable Tailscale. Remote access remains an explicit host opt-in.

## Ownership and transport

The server's device bridge owns local enrollment, account transitions, and the command broker. An account-scoped DeviceBridgeGateway Durable Object stores enrolled devices and secret hashes, owns live outbound desktop sockets, and forwards only signed bridge operations. It never exposes environment RPC. The existing account, workspace, actor, request-body hash, expiry, and command receipt checks remain authoritative.

Desktop credentials live in the additive `device_bridge_enrollment` SQLite table, independently of `api_config`. The account API verifies WorkOS credentials for discovery, enrollment, revocation, and connection. A connection additionally proves the enrolled device secret. Five-minute socket leases require fresh account authentication; heartbeat expiry prevents an open but sleeping socket from being reported connected. Remote revocation fences the socket and requires explicit restoration on its host.

Cloud commands retain their approval policy, durable IDs, bounded output, execution leases, and no-blind-retry behavior. Transport loss does not erase saved approvals. Account changes and disabling access invalidate command authority. Legacy tunnel bridge ingress is disabled; there is no fallback from the new bridge to remote sharing.

## Client behavior

Cloud device discovery and selection use their own shared controller. Automatically binding the desktop only fills an unassigned cloud workspace; it cannot replace an explicit target. An enrolled but disconnected target remains selectable and returns an honest disconnected status. Its commands cannot run until its channel reconnects.

Remote account connections use bounded, staggered authenticated route attempts. Unsupported browser transports and remote loopback addresses are excluded. Losing sessions are interrupted and disposed. Each candidate must complete protocol negotiation and verify the expected environment identity. The existing connection lifetime owns reconnection and synchronization; this route selector does not retry commands.

A saved remote registration is “Not connected,” not evidence of an offline computer. Transport state remains distinct from account presence and shell synchronization. Setup read failures are visible and do not masquerade as disabled sharing.

## Deployment and rollback

Deploy the API Worker with its appended `device-bridge-v1` Durable Object migration and `DEVICE_BRIDGE_GATEWAY` binding before shipping clients. Both staging and production configurations include the binding. Absence of that binding produces an update-required response and does not fall back to a tunnel.

Local SQLite migration 0089 only adds a table; it changes no runtime data paths and preserves command history. The change in bridge authority invalidates permissions attached to the old tunnel enrollment; users approve new commands under the independent enrollment. Old remote pairing records are retained.

Roll out clients after API smoke tests. Check desktop enrollment, same-account discovery, independent disable/revoke, signed request rejection, expiry, and reconnect. Inspect request/connection failures without logging credentials or command contents. Roll back clients before removing API serving support; retain the Durable Object binding and SQLite table during rollback. No production deployment is performed by repository changes alone.
