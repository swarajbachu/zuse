# Public API

The public API (`/v1/api/**` on the API) lets external integrations — Slack
bots, CI, scripts — drive Cloud Workspaces without first-party auth. It covers
the core loop only: create a workspace with a prompt, send follow-up messages,
read replies, and check status. Everything else (SSH, previews, transcripts,
billing) stays on the first-party surfaces.

A reference Slack app that uses only this API lives at
[`examples/slack-bot`](../../examples/slack-bot/README.md).

## Authentication

Requests carry an account-scoped API key:

```
Authorization: Bearer zk_…
```

Keys are minted in Zuse under **Settings → Cloud Workspace → API keys** (or via
the WorkOS-gated `POST /v1/cloud/api-keys`). The secret is shown once; the
API stores only its SHA-256 hash. Revoking a key takes effect immediately.
A key inherits the full cloud access of its account — treat it like a
password.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/api/projects` | Connected repositories to target |
| `POST` | `/v1/api/workspaces` | Create a workspace running a prompt |
| `GET` | `/v1/api/workspaces` | List workspaces with status |
| `GET` | `/v1/api/workspaces/{id}` | Status: `state`, `startupPhase`, `agentStatus`, `lastTurn`, `latestSeq` |
| `POST` | `/v1/api/workspaces/{id}/messages` | Send a follow-up message to the agent |
| `GET` | `/v1/api/workspaces/{id}/messages?afterSeq=&limit=` | Poll the conversation ledger |
| `POST` | `/v1/api/webhooks` | Register a webhook endpoint (secret shown once) |
| `GET` | `/v1/api/webhooks` | List webhook endpoints |
| `DELETE` | `/v1/api/webhooks/{id}` | Remove a webhook endpoint |

Errors use the API convention: an HTTP status plus `{"error": "<code>"}`.
Notable codes: `workspace_not_accepting_messages` (409 — archived, deleting, or
failed), `cloud_project_required` (400 — several ready projects, pass
`projectId`), `agent_and_model_required` (400 — no prior workspace to default
from).

### Create a workspace

```sh
curl -X POST "$ZUSE_API_URL/v1/api/workspaces" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Idempotency-Key: task-42" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the login redirect bug"}'
```

`projectId`, `providerId`, `agent`, `model`, `baseRef`, and `branch` are
optional: the project defaults when the account has exactly one ready project,
agent/model default from the account's most recent workspace, and `baseRef`
defaults to the project's default branch. The response is the workspace status
object; the prompt is delivered through the same sealed one-shot launch intent
as first-party creates.

### Send a follow-up message

```sh
curl -X POST "$ZUSE_API_URL/v1/api/workspaces/$WS/messages" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Idempotency-Key: reply-1" \
  -H "Content-Type: application/json" \
  -d '{"text": "Also add a regression test"}'
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
original workspace or message instead of creating a duplicate.

### Poll replies

```sh
curl "$ZUSE_API_URL/v1/api/workspaces/$WS/messages?afterSeq=0" \
  -H "Authorization: Bearer $ZUSE_API_KEY"
```

The conversation ledger is an ordered, monotonically sequenced exchange of
`user` and `assistant` rows. Store the highest `seq` you have seen and pass it
back as `afterSeq`. Assistant rows carry `turnId`, `outcome`, and a bounded
reply excerpt (up to 16 KB of the final assistant text; tool output and
attachments are not included — those live in the full transcript surfaces).
The ledger follows the workspace's initial session.

## Webhooks

Register an endpoint once per account:

```sh
curl -X POST "$ZUSE_API_URL/v1/api/webhooks" \
  -H "Authorization: Bearer $ZUSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/zuse-hook"}'
```

The response includes a `whsec_…` signing secret, shown once. Each time an
agent turn completes, the API POSTs a `workspace.turn.completed` event:

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
  "messageSeq": 3
}
```

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

## Delivery model

- The API is the durable queue: messages and webhook deliveries are Postgres
  rows; the workspace gateway only nudges the runtime that work is waiting.
- The runtime pulls pending commands, injects them idempotently, and acks;
  a missed nudge is recovered on gateway reconnect and by the cron sweep.
- Message content, webhook payloads, and webhook secrets are sealed at rest
  with the API data-encryption key, bound to their owning account and row.
