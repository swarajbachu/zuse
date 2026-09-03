# Cloud security

Zuse Cloud treats the desktop, mobile client, API, gateway, provider sandbox,
and object storage as separate trust boundaries. Long-lived provider or account
credentials are never used as client connection credentials.

## Identity and private-beta authorization

WorkOS verifies the signed-in account. For user-facing hosted operations, API
then evaluates the server-side PostHog flag `zuse-cloud-beta-access` using the
verified WorkOS account ID. API never trusts a client-supplied account ID or a
renderer-evaluated feature flag.

The gate covers cloud creation and mutation, resume, transcript/key retrieval,
gateway client tickets, managed hosted machines, checkout, portal, usage, and
cap routes. It deliberately does not cover runtime enrollment and renewal,
signed runtime callbacks, checkpoint uploads, lifecycle callbacks, or provider
webhooks. This lets an already accepted turn settle after access is removed
without granting another user operation.

The WorkOS-authenticated entitlement lookup is the sole bootstrap exception:
after API verifies an active Polar subscription, it sets
`zuse_cloud_beta_access=true` for the account's privacy-preserving PostHog
identity. It cannot create or resume compute itself. PostHog deny returns
`cloud_beta_access_required`. Evaluation timeout, malformed
data, or outage returns `cloud_beta_access_unavailable`; production fails closed
for new hosted operations. Neither result signs the user out or removes cached
transcripts. Local, SSH, pairing, and ordinary remote-server paths are outside
this gate.

## Runtime bootstrap and generations

The provider receives a one-time workspace boot token, not a reusable account
credential. During bootstrap the runtime registers separate signing and
encryption public keys and exchanges the token for a scoped renewable runtime
credential. The boot token is then removed.

Credentials bind workspace identity, runtime generation, gateway epoch, and
scope. Lifecycle and checkpoint writes compare the caller's generation with the
current workspace record. Replaced or stale runtimes cannot publish a newer
summary, checkpoint pointer, or endpoint.

## Client tickets and gateway

API issues short-lived client tickets bound to account, device, workspace,
role, protocol version, runtime generation, and gateway epoch. The hibernatable
WorkspaceGateway Durable Object validates the ticket before accepting a socket
and forwards opaque binary RPC frames between the authenticated client and
runtime.

The gateway stores only live attachment metadata. It has no transcript, replay
log, command queue, or pending-frame database. Clients do not connect directly
to E2B, so provider bearer tokens and sandbox access tokens never become the
application authorization boundary.

Eligible cloud commands instead use the separately addressed WorkspaceMailbox.
Its ID is the stable workspace ID rather than a gateway epoch. It stores only
AES-GCM ciphertext plus authenticated routing metadata, keyed fingerprints,
lease fences, and encrypted results. Normal routing never unwraps the workspace
data key; decryption and authoritative application happen in the runtime.

## Credentials and secrets

- Repository and agent credentials are encrypted in the cloud credential vault
  and delivered only to the authenticated workspace runtime.
- The base template and prepared project snapshots are credential-free.
- Project snapshot sanitation removes repository tokens, agent credentials,
  runtime identity, authorized keys, and shell history.
- SSH uses a ticket-gated runtime WebSocket route and a per-workspace host key;
  it does not expose a public provider SSH listener.
- API signing keys, WorkOS, Cloudflare, E2B, PostHog, Polar, webhook, and vault
  secrets are Worker secrets, not tracked configuration values.
- Staging and production use separate configs, secrets, runtime signing keys,
  template versions, provider webhooks, and databases.

## Transcript encryption

Each workspace has a transcript key stored wrapped by the API vault key.
Runtime checkpoint payloads are compressed and encrypted with AES-256-GCM.
Workspace, session, cursor epoch/version, and schema version are authenticated
additional data, preventing a valid ciphertext from being moved to another
workspace or cursor.

R2 receives immutable ciphertext. API records and verifies its SHA-256 and
byte size before advancing a monotonic pointer. An authorized owning client
receives the transcript key with the protected checkpoint response, uses it for
integrity-checked decryption, and does not put it into canonical ClientBus or UI
state. API stores only its wrapped envelope; R2 never receives the plaintext
key.

## Webhooks and billing evidence

E2B and Polar webhooks require their provider signatures. A recovery poll may
observe the same provider execution as a webhook; the normalized provider event
and immutable finalization key make charging idempotent. Raw evidence expires
under the billing retention policy while pseudonymous finalization records
remain long enough to reject old redelivery.

## Revocation and deletion

Removing beta access blocks new create, resume, mutation, transcript retrieval,
and reconnect operations. Existing short-lived tickets expire naturally; API
can fence a runtime by advancing its generation or gateway epoch.

Permanent workspace deletion kills the provider sandbox, deletes R2 transcript
objects and checkpoint pointers, revokes runtime credentials and tickets, and
removes wrapped transcript keys and launch content. A content-free tombstone
briefly remains so offline clients learn to erase local cached content.
