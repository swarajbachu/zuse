# Zuse Slack bot (reference)

A minimal Slack app that drives Zuse Cloud Workspaces entirely through the
[public API](../../docs/cloud/public-api.md) — the same surface any external
integration would use. No first-party API auth, no SDKs: one Cloudflare
Worker, an API key, and a webhook.

What it does:

- `/zuse <prompt>` starts a cloud workspace and posts a channel message.
- Replies in that message's thread are forwarded to the agent as follow-ups.
- When the agent finishes a turn, Zuse's webhook posts the reply into the
  thread.

## Setup

### 1. Zuse credentials

1. In Zuse: **Settings → Cloud Workspace → API keys → Create key**. Copy the
   `zk_…` secret.
2. Register a webhook endpoint pointing at this worker (after the first
   deploy you will know the URL):

   ```sh
   curl -X POST "$ZUSE_API_URL/v1/api/webhooks" \
     -H "Authorization: Bearer $ZUSE_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://<your-worker>.workers.dev/zuse/webhook", "description": "slack bot"}'
   ```

   Copy the `whsec_…` secret from the response — it is shown once.

### 2. Slack app

Create a Slack app (<https://api.slack.com/apps>) with:

- **Slash command** `/zuse` → request URL `https://<worker>/slack/commands`.
- **Event subscriptions** enabled → request URL `https://<worker>/slack/events`,
  subscribed to the `message.channels` bot event.
- **Bot token scopes**: `chat:write`, `commands`.

Install it to your workspace and note the **signing secret** and the `xoxb-`
**bot token**.

### 3. Deploy

```sh
cd examples/slack-bot
bun install
wrangler kv namespace create THREADS   # paste the id into wrangler.jsonc
bun run secret:slack-signing
bun run secret:slack-bot-token
bun run secret:zuse-api-key
bun run secret:zuse-webhook
bun run deploy
```

Set `ZUSE_API_URL` in `wrangler.jsonc` if you are not using the production
API.

## How it maps to the API

| Slack interaction | Public API call |
| --- | --- |
| `/zuse <prompt>` | `POST /v1/api/workspaces` with `Idempotency-Key: slack:<trigger_id>` |
| Thread reply | `POST /v1/api/workspaces/{id}/messages` with `Idempotency-Key: slack-event:<event_id>` |
| Agent reply | `workspace.turn.completed` webhook, verified via `zuse-signature` |

The `workspaceId ↔ (channel, thread_ts)` mapping lives in Workers KV; webhook
deliveries are deduplicated by `eventId`. Everything else is stateless.
