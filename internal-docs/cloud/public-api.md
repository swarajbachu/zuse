# Public API

The public API (`/v1/api/**` on the api) lets external integrations — Slack
bots, CI, scripts — drive Cloud Workspaces without first-party auth. It covers
the core loop only: create a workspace with a prompt, send follow-up messages,
read replies, and check status. Everything else (SSH, previews, transcripts,
billing) stays on the first-party surfaces.

Zuse's [first-party Slack app](slack-app.md) lets you connect your Zuse account
and configure alert automations without pasting an API key.

## Authentication

Requests carry an account-scoped API key:

```
Authorization: Bearer zk_…
```

Keys are minted in Zuse under **Settings → Cloud Workspace → API keys** (or via
the WorkOS-gated `POST /v1/cloud/api-keys`). The secret is shown once; the
`zk_` secret contains 32 random bytes encoded as fixed-width base62, and the
api stores only its SHA-256 hash. Revoking a key takes effect immediately.
A key inherits the full cloud access of its account — treat it like a
password. Every request rechecks the account's current beta access and cloud
entitlement; removing either blocks new reads and mutations even if a key has
not yet been revoked. Webhook deletion remains available as cleanup.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/api/projects` | Connected repositories to target |
| `POST` | `/v1/api/workspaces` | Create a workspace, optionally running a prompt |
| `GET` | `/v1/api/workspaces` | List workspaces with status |
| `GET` | `/v1/api/workspaces/{id}` | Status: `state`, `startupPhase`, `agentStatus`, `lastTurn`, `latestSeq` |
| `POST` | `/v1/api/workspaces/{id}/messages` | Send a follow-up message to the agent |
| `POST` | `/v1/api/workspaces/{id}/attachments` | Upload a sealed image/file for a message |
| `GET` | `/v1/api/workspaces/{id}/messages?afterSeq=&limit=` | Poll the conversation ledger |
| `POST` | `/v1/api/webhooks` | Register a webhook endpoint (secret shown once) |
| `GET` | `/v1/api/webhooks` | List webhook endpoints |
| `DELETE` | `/v1/api/webhooks/{id}` | Remove a webhook endpoint |

Errors use the api convention: an HTTP status plus `{"error": "<code>"}`.
Notable codes: `workspace_not_accepting_messages` (409 — archived, deleting, or
failed), `cloud_project_required` (400 — several ready projects, pass
`projectId`), `agent_and_model_required` (400 — no prior workspace to default
from).

### Create a workspace

```sh
curl -X POST "$API_BASE/v1/api/workspaces" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Idempotency-Key: task-42" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the login redirect bug"}'
```

`prompt` may be omitted when an integration needs the workspace identity
before uploading rich context. Such a workspace starts idle; upload its assets
and then send the first message. `projectId`, `providerId`, `agent`, `model`,
`baseRef`, and `branch` are
optional: the project defaults when the account has exactly one ready project,
agent/model default from the account's most recent workspace, and `baseRef`
defaults to the project's default branch. The response is the workspace status
object; the prompt is delivered through the same sealed one-shot launch intent
as first-party creates.

`providerId` accepts `"box"` or `"e2b"` when configured. Omitted placement uses
`SANDBOX_DEFAULT_PROVIDER_ID` (Box when both adapters are configured without an
override), rather than inheriting the previous workspace's provider. Each choice
requires a ready account image for that provider. Existing workspace operations
continue using the provider stored on that workspace. Account-authenticated image
status accepts `?providerId=box` or `?providerId=e2b`; image builds accept the same
optional `providerId` in their JSON body.

API-created workspaces default to `runtimeMode: "full-access"` for unattended
execution. Set `runtimeMode` explicitly to `approval-required`,
`auto-accept-edits`, or `auto-accept-edits-and-bash` for stricter approval rules.
Full access uses the existing runtime policy, including sensitive-path and
plan-mode safeguards. Desktop/web creation defaults are unchanged. Replaying
an existing creation request does not change that workspace's access mode.

The API cannot identify a physical desktop as a local-command target. When an
API-created workspace is opened in the desktop app, sending a message attaches
that workspace to the sending desktop. A later send from another linked desktop
moves the target; browser and mobile clients leave the current target unchanged.

### Send a follow-up message

Upload each attachment first using its raw bytes:

```sh
curl -X POST "$API_BASE/v1/api/workspaces/$WS/attachments" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Idempotency-Key: slack-file-F123" \
  -H "Content-Type: image/png" \
  -H "X-Zuse-File-Name: screenshot.png" \
  --data-binary @screenshot.png
```

The response is `{asset: {assetId, mimeType, originalName, sizeBytes}}`. Asset
bytes are sealed in workspace-scoped object storage and can only be fetched by
that workspace's authenticated runtime. Individual assets are capped at 20
MiB; messages may reference at most eight assets.

```sh
curl -X POST "$API_BASE/v1/api/workspaces/$WS/messages" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Idempotency-Key: reply-1" \
  -H "Content-Type: application/json" \
  -d '{"text": "Also add a regression test", "attachments": ["asset_…"]}'
```

Returns `{messageId, seq, status, resumeTriggered}`. Messages are stored
durably (sealed at rest) and delivered to the in-sandbox runtime at
least once through the gateway; the runtime injects them through the same
idempotent command path as any other prompt, so redelivery never duplicates a
turn. Sending to a paused workspace queues the message and triggers a resume
(`resumeTriggered: true`). Undelivered messages expire after 24 hours; their
`status` stays visible via polling.

### Idempotency

`POST /v1/api/workspaces` and `POST …/messages` accept an `Idempotency-Key`
header (or `idempotencyKey` body field). Retries with the same key return the
original workspace or message instead of creating a duplicate. Keys must be
non-empty and at most 200 characters. If both locations are present they must
match, and reusing a key with a different normalized request returns `409`
instead of silently dropping the new work.

Workspace-create receipts live with the workspace. Message receipts are kept
for at least 30 days and longer while they remain among the workspace's newest
1,000 terminal ledger rows. Callers must not reuse a message idempotency key
after that retention window.

### Poll replies

```sh
curl "$API_BASE/v1/api/workspaces/$WS/messages?afterSeq=0" \
  -H "Authorization: Bearer $ZUSE_API_KEY"
```

The conversation ledger is an ordered, monotonically sequenced exchange of
`user` and `assistant` rows. Store the highest `seq` you have seen and pass it
back as `afterSeq`. Assistant rows carry `turnId`, `outcome`, and a bounded
reply excerpt (up to 16 KB of the final assistant text; tool output and
attachments are not included — those live in the full transcript surfaces).
The ledger follows the workspace's initial session.
User rows include optional `deliveredAt` (Unix milliseconds) once the runtime
acknowledges delivery. `deliveredAt - createdAt` measures API acceptance to
delivery acknowledgement, independently of polling cadence or model completion.
Historical rows may omit it.

## Webhooks

Register an endpoint once per account:

```sh
curl -X POST "$API_BASE/v1/api/webhooks" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/zuse-hook"}'
```

Webhook targets must be public HTTPS hostnames (no credentials, fragments,
literal/private/loopback addresses, or redirects). An account may keep up to
20 active endpoints.

The response includes a `whsec_…` signing secret, shown once. Each time an
agent turn completes, the api POSTs a `workspace.turn.completed` event:

```json
{
  "eventId": "evt_…",
  "type": "workspace.turn.completed",
  "createdAt": 1766000000000,
  "workspaceId": "workspace_…",
  "branch": "pikachu",
  "turnId": "…",
  "outcome": "completed",
  "reply": { "text": "Done — the redirect now …", "truncated": false },
  "messageId": "msg_turn_…"
}
```

`messageId` is deterministic for the completed turn and identifies the
assistant row returned by the conversation-ledger endpoint.

Deliveries carry:

- `zuse-event-id` — stable per event; deduplicate on it (deliveries are
  at-least-once).
- `zuse-delivery-attempt` — 1-based attempt counter.
- `zuse-signature: t=<unixSeconds>,v1=<hex>` — HMAC-SHA256 of
  `<t>.<rawBody>` with your endpoint secret. Reject requests older than five
  minutes and compare signatures in constant time:

```js
const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header) ?? [];
const expected = hmacSha256Hex(secret, `${t}.${rawBody}`);
```

Failed deliveries retry with exponential backoff (30 s doubling, capped at one
hour) for up to 20 attempts. Respond with any 2xx to acknowledge. Polling
remains available as a fallback if your endpoint is down.
