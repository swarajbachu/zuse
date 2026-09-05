# Zuse Slack bot (reference)

A minimal Slack app that drives Zuse Cloud Workspaces entirely through the
[public API](../../docs/cloud/public-api.md) — the same surface any external
integration would use. No first-party api auth, no SDKs: one Cloudflare
Worker, an API key, and a webhook.

What it does:

- `/zuse <prompt>` starts a cloud workspace and posts a channel message.
- **Open thread in Zuse** imports an existing thread, including supported
  images/files, into a new cloud workspace.
- Replies in that message's thread are forwarded to the agent as follow-ups.
- Images/files added to follow-up replies travel through Zuse's normal
  attachment pipeline and appear under the workspace's `.context/files/`.
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

Create a Slack app (<https://api.slack.com/apps>) by importing
[`slack-manifest.example.yaml`](./slack-manifest.example.yaml) after replacing
`YOUR_WORKER`, or configure it manually with:

- **Slash command** `/zuse` → request URL `https://<worker>/slack/commands`.
- **Event subscriptions** enabled → request URL `https://<worker>/slack/events`,
  subscribed to the message events for every conversation type you want to
  support.
- **Interactivity** → request URL `https://<worker>/slack/interactions`, with a
  message shortcut whose callback id is `open_in_zuse`.
- **Bot token scopes**: `chat:write`, `commands`, plus the appropriate
  `*:history` scopes from the manifest.

Install it to your workspace and note the **signing secret**, the `xoxb-`
**bot token**, and the installer's `xoxp-` **user token**. Slack requires a
user token to hydrate existing public/private channel threads; bot tokens can
hydrate direct-message threads.

### 3. Deploy

```sh
cd examples/slack-bot
bun install
wrangler kv namespace create THREADS   # paste the id into wrangler.jsonc
bun run secret:slack-signing
bun run secret:slack-bot-token
bun run secret:slack-user-token
bun run secret:zuse-api-key
bun run secret:zuse-webhook
bun run deploy
```

`ZUSE_API_URL` defaults to the production API, `https://api.zuse.sh`.
Override it in `wrangler.jsonc` for another deployment or local development.

Set `ZUSE_AGENT` and `ZUSE_MODEL` in the worker's `vars` to your configured
cloud agent and model IDs. Set `ZUSE_PROJECT_ID` when you have multiple ready
projects. Without agent/model settings, the API can reuse a previous workspace's
configuration, but a fresh account has no defaults and creation will fail.

## Testing

Run `bun run test` here for Slack signature, retry, import, and webhook tests.
From `infra/api`, run `bunx vitest run test/integration/public-api.test.ts`
for the signed Slack thread → real API → runtime attachment download/ACK →
turn completion → signed webhook → Slack reply round trip. Only Slack's
external HTTP endpoints, storage, and sandbox provisioning are substituted;
this does not claim a live Slack installation or real agent execution.

For live testing, deploy the API with migrations `0019_public_api` and
`0020_public_api_reliability`, publish the updated cloud runtime, configure
the worker and Slack manifest, and use a test channel. Select **Open thread
in Zuse** on a thread containing an image, wait for the agent reply, then
send an image-only follow-up. Confirm both images are present in the
workspace's `.context/files/` and the replies stay in the same Slack thread.

The Slack app can be used from Slack web, desktop, or mobile. Zuse's hosted
web UI currently opens through a linked Zuse Serve computer; it does not yet
offer a standalone account-owned cloud-workspace picker. The shared renderer
can access cloud chats once that control-plane connection is established.

## How it maps to the API

| Slack interaction | Public API call |
| --- | --- |
| `/zuse <prompt>` | `POST /v1/api/workspaces` with `Idempotency-Key: slack:<trigger_id>` |
| Open thread in Zuse | Create idle workspace → upload files → send bounded thread context |
| Thread reply | `POST /v1/api/workspaces/{id}/messages` with `Idempotency-Key: slack-event:<event_id>` |
| Agent reply | `workspace.turn.completed` webhook, verified via `zuse-signature` |

The `workspaceId ↔ (channel, thread_ts)` mapping lives in Workers KV. KV is a
best-effort fast dedupe layer for webhook `eventId` values; every Slack post
also carries a deterministic `client_msg_id`, so a retry after Slack accepted
the message cannot duplicate it even if the KV write failed. Everything else
is stateless.

The app reads only the thread explicitly selected by a user, and Slack still
enforces the bot's channel membership and granted history scopes. Imports are
bounded to 500 thread messages, 60,000 text characters, and the newest eight
supported images, documents, or text archives. Each asset is limited to 20
MiB. Zuse seals asset bytes before placing them in the workspace-scoped object
store, and the authenticated runtime materializes them through the same
attachment module used by the desktop composer.
