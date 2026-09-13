# Slack conversation experience

Researched 2026-09-13 against primary OpenClaw and Slack documentation. This is
design input, not a statement that every capability below is implemented or deployed.

## OpenClaw reference

OpenClaw separates its Slack integration from its agent runtime. It supports HTTP
events as well as Socket Mode. Its current manifest enables a writable Messages
tab, mentions, DMs, and optional native agent surfaces. Zuse can keep HTTP callbacks
under the API hostname while giving Slack its own application module; a separate
hostname is not required by Slack's HTTP integration model. The module choice is
our architectural recommendation, not an OpenClaw requirement.
[Setup and manifest](https://docs.openclaw.ai/channels/slack/manifest-and-scopes),
[transports](https://docs.openclaw.ai/channels/slack/transports).

Current OpenClaw defaults to progress mode: a single native task-card stream can
carry work updates and finish with the answer. It has a Block Kit fallback, keeps
acknowledgement reactions static, and hides raw command text by default. Tool
progress is opt-in; routine updates are coalesced. Copy the quiet, truthful progress
pattern, not every optional scope or command. “Thinking” should mean a loading
indicator or short work summary, never a dump of private model reasoning.
[Message behavior](https://docs.openclaw.ai/channels/slack/messaging).

OpenClaw keys thread conversations by their parent timestamp, seeds an admitted
mention into that thread session, and allows follow-ups in threads where it has
participated. For Zuse, additionally bind execution to the authenticated initiating
user and authorized repository; another thread participant must not inherit that
user's repository credentials merely by posting a reply.
[Threads and sessions](https://docs.openclaw.ai/channels/slack/threads-and-sessions).

## Required conversation entry points

| Surface | Configuration | Proposed Zuse behavior |
| --- | --- | --- |
| Channel mention | `app_mentions:read`, `app_mention` event | Acknowledge and reply in the original thread; ask for account/project setup if missing. |
| App DM | `im:history`, `message.im`; writable Messages tab | Same conversation flow without requiring a mention. |
| Existing channel thread | Existing `message.channels` / `message.groups` and history scopes | Continue only a known, authorized Zuse conversation; ignore unrelated chatter. |
| App Home | Existing `app_home_opened` | Show account connection, repository/project selection, and automation settings. |
| Receipt reaction | `reactions:write` | Optional static acknowledgement, independent of execution correctness. |

Sources: [mentions](https://docs.slack.dev/reference/events/app_mention/),
[DM events](https://docs.slack.dev/reference/events/message.im/),
[OpenClaw manifest](https://docs.openclaw.ai/channels/slack/manifest-and-scopes),
[reaction method](https://docs.slack.dev/reference/methods/reactions.add/).

Keep bot-alert automation routing separate from human task routing. Do not add
slash commands just to support natural mentions. Request additional scopes only
when needed: `im:write` for opening DMs, `files:write` for uploading results, and
channel-list scopes for a Slack-channel picker. OAuth grants must be refreshed
through installation/authorization after adding scopes; deploying code alone does
not grant new permissions.
[OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/).

## Native progress and final response

Slack's current preferred lifecycle API is `agents.sessions.setStatus`, using
`chat:write`. Regular channel/DM sessions need `channel_id` and `thread_ts`.
`processing` displays loading, `suspended` requests intervention, and `active`
marks readiness for another prompt. `closed` ends the session. It may return
`feature_disabled`, so native lifecycle support cannot be the only visible reply
path. Subscribe to `agent_session_stopped` only when cancellation is implemented;
that subscription enables Slack's stop button.
[Agent lifecycle method](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/).

The compatibility API `assistant.threads.setStatus` accepts `chat:write`, a short
`status`, and up to ten rotating `loading_messages`. Status expires after two
minutes and clears when the app replies; an empty status clears it explicitly.
Long-running jobs need lifecycle refreshes or a persistent progress message, not
an assumed permanent spinner.
[Assistant status method](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/).

Native text/task streaming uses `chat.startStream`, `chat.appendStream`, and
`chat.stopStream` with `chat:write`. Ordinary channel replies need a thread root;
channel streams also need the recipient's Slack user and team IDs. Start returns
the message timestamp, which must be retained for appends and completion. Task
updates can render `in_progress`, `complete`, or `error` rows in timeline or plan
mode. Use only real work events; never infer that tests passed from elapsed time.
[Streaming method and chunk schema](https://docs.slack.dev/reference/methods/chat.startStream/).

Recommended first release: one durable threaded acknowledgement/progress message,
best-effort native loading, then a final result containing completed work, checks
actually run, any blockers, and a valid authenticated session link when available.
Use the agent's final output as the source of the summary. Do not post only a
workspace ID or claim completion when the workspace merely started. Stream output
only when the backend exposes resumable, attributable progress; otherwise update
the existing message at meaningful lifecycle transitions.

## Thread context, images, and reliability

Current `conversations.replies` documentation lists channel/group history scopes
for both bot and user tokens. Older advice that channel threads always require a
user token should not be treated as a universal rule. Fetch only accessible
threads and handle denied access explicitly. New commercially distributed,
non-Marketplace apps can be limited to one request per minute and fifteen messages
per call. Cache authorized inbound thread events, paginate within a deliberate
budget, honor rate limits, and tell users when history is incomplete.
[Thread retrieval and rate limits](https://docs.slack.dev/reference/methods/conversations.replies/).

Slack private file URLs and thumbnails need an OAuth bearer token with
`files:read`; a permalink alone does not deliver image bytes to a model. Slack
Connect events can initially contain only a file ID requiring metadata retrieval.
Authorize first, download through a bounded trusted-host path, enforce size/type
limits, and send actual image attachments through Zuse's shared attachment path.
Missing, denied, or unsupported images must produce an explicit limitation rather
than a false claim of visual inspection.
[Slack file access](https://docs.slack.dev/reference/objects/file-object/).

OpenClaw similarly bounds media downloads, preserves a placeholder on retrieval
failure, and routes supported images to vision-capable handling. Reuse existing
Zuse attachment transport rather than copying a Slack-specific model pipeline.
[OpenClaw media behavior](https://docs.openclaw.ai/channels/slack/media).

Slack expects HTTP acknowledgement within three seconds and retries failed
deliveries; `event_id` uniquely identifies an event. Persist/queue accepted work
before acknowledgement, deduplicate deliveries, and keep long-running execution
outside the ingress request. Also deduplicate mention/message representations of
the same human message using workspace/channel/message identity. Persist progress
message identity and job state so retries cannot launch another workspace or
overwrite a final result with stale progress.
[Events API delivery contract](https://docs.slack.dev/apis/events-api/).

## Verification before rollout

- Fresh and existing installs: updated scopes, mentions, writable DMs, account
  linking, repository selection, and an actionable reply before setup is complete.
- Duplicate deliveries, concurrent thread messages, reconnects, and revoked
  credentials do not duplicate work or cross user/workspace boundaries.
- Supported and unsupported native progress both end with a visible final answer;
  errors and approval waits do not remain indefinitely “thinking.”
- Thread-root image, reply image, denied image, oversized image, incomplete history,
  and non-vision model behavior are explicit and tested.
- Human requests still work alongside narrowly configured Better Stack rules;
  unrelated bots and channel chatter do not start work.
