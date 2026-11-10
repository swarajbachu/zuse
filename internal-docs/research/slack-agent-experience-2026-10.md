# Slack agent experience: research and Zuse priorities

Research date: 2026-10-24. Start here, then read the [competitor evidence](slack-agents-competitors-2026-10.md) for Devin, Cursor, Factory, Claude and Copilot. This document adds Capy, platform constraints, a source-code audit of Zuse, and proposed behavior. It extends the [September research](slack-conversation-experience.md); that document is historical input, not proof of current implementation.

## Main finding

A long task needs a visible, controllable lifecycle. Users need to know what the agent understood, which code and account it is using, what changed since the last update, whether it is waiting for them, and where the work survives a failure. A spinner and a final reply cannot answer those questions over twenty minutes.

The strongest patterns in the documented products are persistent context, visible work stages, steering/cancellation, and reviewable outputs. Some competitors now support dedicated Slack code channels with repository context and artifacts. These are supported features in public documentation, not evidence that competitors meet latency or reliability guarantees. Their private worker architecture, production failure rates, and staffing/maintenance practices are unknown.

This is research and a proposed direction. No Slack application behavior was changed, no authenticated competitor trial was performed, and no production logs were accessed. The user's reported errors still need incident evidence before assigning a root cause.

## Deliverables and visual provenance

- [Competitor dossier](slack-agents-competitors-2026-10.md): six comparison entries, including separate current and legacy Claude experiences, plus primary sources and demonstration links.
- [Image gallery](../../.context/slack-research/gallery.html): local, filterable visual references with source links. Images open at original size. This file requires no build or external scripts.
- [Asset manifest](../../.context/slack-research/images.json): original URLs, publisher page, image type, and downloaded byte counts.
- Local images live in `.context/slack-research/`, as required by this workspace's screenshot instructions. That directory is gitignored and ephemeral; the tracked research retains publisher/source links. Preserve the directory before retiring the VM if an offline archive is needed.

Images are original publisher assets or browser captures of public pages, not reconstructed competitor mockups. A marketing example demonstrates presentation, not measured task speed. Published images can lag the current written documentation. Devin's CDN returned HTTP 403, so its four published images were downloaded through equivalent `docs.devin.ai/images/` URLs; the manifest records the working URLs. Factory's reviewed delegation page did not expose product screenshots. Neither limitation is filled with invented images.

## Capy / Capy.ai

These names refer to the same product here: Capy at capy.ai. Other similarly named bots are outside this comparison.

### Slack feature inventory

Capy's [Slack documentation](https://docs.capy.ai/integrations/slack) documents:

| Area | Features |
| --- | --- |
| Start/context | Mentions, DMs, synchronized thread conversations, image/file context, default project and channel mappings. |
| Conversation controls | `help`; `aside`/`!aside` excludes a message from processing and history; mute/unmute controls regular replies while mentions still work; stop ends the run; archive/unarchive closes/reopens the thread. |
| Handoff | `unlink` pauses Slack sync while web work continues. `!web` creates a separate web conversation; `!new` forks into a separate Slack thread. |
| Routing | `project`, `folder`, `channel`, `title`, `model`, `reasoning`, `machine`; ambiguous choices ask for selection. |
| Delivery | `!steer`, `!queue`; fast/pro/standard and reasoning flags. |
| Identity | Optional personal account linking attributes ownership and message authors. |
| Results | One live card per PR: state/checks/branches/diff totals, Capy/GitHub actions; merge/close gets a short notification. |
| Slack tools | Read/search accessible conversations, list channels, send messages/files, react. |

Muted threads retain updates to existing PR cards. Archived Slack threads require explicit unarchive. Help and mute confirmations are ephemeral. Permissions and bot membership constrain access. Exact acknowledgement timing, progress cadence, retry/resume guarantees and Slack error UX are not established by this page.

### What makes long work understandable

[Thread documentation](https://docs.capy.ai/threads) distinguishes Working, Waiting, Failed and Idle using agent/subagent activity. Waiting names an external dependency; failure leaves an error card. The web composer exposes steer, interrupt and queue separately and allows pending messages to be edited or discarded. Thread artifacts include machines, subagents and PRs. These are web capabilities unless the Slack page separately documents them; do not label every web control a Slack button.

[Background work](https://docs.capy.ai/async-work) describes event-driven continuation: CI, reviews, other agents, timers, watched events, and new human messages can wake a thread. Users can choose whether feedback wakes the agent, becomes future context, or is ignored. Waiting identifies the event and exposes running activity. Long commands have explicit timeouts and machine-awake limits; a detached process or timer alone does not keep the machine alive. Slack messages interrupt by default; `!steer` and `!queue` change delivery. This matters because a casual follow-up should have predictable effects on a running agent.

[Pull requests](https://docs.capy.ai/pull-requests) ties follow-up events to an owning thread, supports draft/readiness defaults and review/CI/conflict responses, and supports stacks. These are broader product capabilities. Combined with the Slack card, they keep a delivered PR connected to ongoing work rather than treating the initial PR URL as completion of everything.

[Captains](https://docs.capy.ai/captains) are an opt-in experiment for coordinating multiple threads. A digest separates decisions needing the user, new results and work in progress. Slack can route to one with `captain=<name>`; the Captain documentation describes a link back to its interface. The useful design principle is attention management: notify the person when a decision is theirs, with the larger work graph available for inspection.

[Marketing integration overview](https://capy.ai/integrations) describes granular integration permissions, disconnection notifications and reconnection. Its claim that no work is lost is a vendor assertion, not an independently tested recovery guarantee. The [Slack landing page](https://capy.ai/integrations/slack) illustrates channel delegation and private DMs; its standup/PR speed copy is not a benchmark.

## Comparison by user problem

The following is a synthesis of the linked primary-source dossier and Capy sources above. Unknown means this research did not establish it; it does not mean the feature is absent.

| Product | Context and routing | During a long task | Human control | Review/handoff |
| --- | --- | --- | --- | --- |
| Capy | Thread/files, project mappings, model directives, linked identity | Web work/wait/failure states; Slack sync and live PR cards | Stop, steer, queue, mute, aside, archive, unlink/fork | Updated PR cards; web review |
| Devin | Thread/attachments, playbooks; explicit limited-context notice if source inaccessible | Code-channel status and live worklog | Ask mode, aside/mute, sleep/archive, session placement | Web sync, PR context/tabs, environment proposal actions |
| Cursor | Whole thread; routing/defaults and overrides | Plan for implementation work; native status; running-agent listing | Targeted follow-up, stop/archive, change repo into new run | Open in Cursor, PR notification, request ID |
| Factory | Thread/images; shared service identity in channels, personal in DMs | Updates; substantial work can move to code channel with repo/branch/diff | Questions, follow-ups, explicit new channel and archive | Generated files, result videos, PR summary |
| Claude Tag | Scoped channel memory, shared tools, personal DM connectors | Staged async tasks, optional ambient follow-up | Team steering; admin access/spend controls | Created work in thread, activity/requester audit |
| Legacy Claude Code Slack | Thread/recent channel context, repository choice | Progress and web transcript | Retry as Code, Change Repo, web continuation | Summary, View Session, Create PR |
| Copilot | Shared session context, repo/branch/defaults; personal DM identity | Code-channel status and artifacts | Team steering, stopping, archive/reopen | Plans, diffs, HTML previews, issues/PRs |

References: [Devin](https://docs.devin.ai/integrations/slack), [Cursor](https://prod.cursor.com/docs/integrations/slack), [Factory](https://docs.factory.com/delegations/slack), [Claude Tag](https://support.claude.com/en/articles/15594475-what-is-claude-tag), [legacy Claude](https://code.claude.com/docs/en/slack), [Copilot](https://docs.github.com/en/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack). Consult the dossier for availability and source-date caveats, especially Claude migration and Copilot plan eligibility.

## Slack platform capabilities and constraints

### Native task UI

[Slack Code](https://docs.slack.dev/ai/slack-code/) provides dedicated per-task channels with a context bar and managed views for diffs, HTML, Block Kit and canvases. Archived history remains available. Code-channel management requires `code_channels:manage`; ordinary session lifecycle uses `chat:write`. A channel is one session, whereas ordinary conversations use a thread timestamp. Treat access/rollout and reauthorization as feature detection and installation concerns.

[`agents.sessions.setStatus`](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/) is the documented primary lifecycle API: `processing` means work, `suspended` means user intervention, `active` means ready for another prompt, and `closed` ends participation. Stop appears when the app subscribes to `agent_session_stopped`. `feature_disabled` is a documented failure, so a durable ordinary-message surface remains necessary. A Slack stop affordance must be connected to real backend cancellation before it is exposed.

[`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/) supports text, task updates, plan updates and blocks. Task display can be timeline or plan. Channel streaming requires recipient identity. Store the returned timestamp and serialize append/stop operations for that stream; use real task events as content. This is a proposed implementation discipline, not a claim that Slack persists Zuse's execution state.

The older [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/) remains a compatibility path. Verify its current lifecycle behavior rather than assuming a spinner is permanent. Clear status on terminal outcomes. The previous September document's API details must be rechecked against current docs before implementation.

### Delivery and context

[Events API](https://docs.slack.dev/apis/events-api/) expects a timely HTTP acknowledgement and retries failed deliveries. Zuse should durably accept/deduplicate work before returning success, then execute asynchronously. The HTTP acknowledgement is distinct from a human-visible receipt and distinct from agent startup. Acknowledging delivery alone does not create a usable waiting experience.

[Rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) vary by method, workspace and app. Honor `Retry-After`, coalesce updates and budget traffic across all runs. [Thread retrieval](https://docs.slack.dev/reference/methods/conversations.replies/) has app-distribution-specific limits; do not build a heartbeat that rereads the whole thread. Cache authorized incoming events, fetch bounded history once, and expose incomplete context to the user.

[Slack's agent design guidance](https://docs.slack.dev/concepts/agent-design/) recommends transparent identity, understandable activity, partial-progress preservation and actionable recovery. It also calls for respecting invoking-user access. For Zuse, distinguish human-readable work summaries from private model reasoning; task visibility should show actions, findings and evidence.

## Current Zuse behavior: audited source, not a live incident diagnosis

Audit against the rebased checkout on 2026-10-24. The operations guide is more current than parts of the Slack README: the latter still mentions a durable fallback card and no workspace landing route, whereas code now has reaction-only fallback and an authenticated workspace link. Recommendations below use code as evidence. Those README discrepancies are recorded here; unrelated documentation was not rewritten as part of this research.

| Area | What the current code does | Experience gap |
| --- | --- | --- |
| Entry/setup | Mentions, DMs, per-member account linking, repository and agent/model picker, reply preference. | Setup choices are available, but a long run lacks a persistent visible summary of the resolved execution context. |
| Initial activity | `startProgress` sets native “Zusing…” and a custom cooking reaction, falling back to hourglass. | Acknowledgement says little about what was understood. No durable intermediate card is created. |
| Preparation | Reads/caches bounded existing-thread context when first invited; forwards supported attachments through shared upload path. | Context import exists; users cannot easily inspect an inclusion/omission receipt. This is different from saying context is never sent. |
| Running | Polls every 30 seconds, then every 5 minutes after an hour. Native phases are work, wait for result, or workspace start. | Generic repeated activity does not reveal investigation, changes, tests, dependency waits or stalled execution. |
| Native UI unavailable | Status failures return false; reaction remains the activity fallback. Preparation also removes an old status message. | The fallback provides almost no information during twenty minutes. |
| Results | Signed correlated webhooks plus polling fallback; final output includes status and `View in Zuse`. | Long final text can be truncated; output has no dedicated structured verification/PR/preview card. Link is delivered with result rather than early receipt. |
| Errors | Specific paths cover provider, agent auth/availability, project setup and workspace failure; generic failures mention several possible causes. | Users often need to leave Slack, reconnect and resend. Partial progress, exact next action and retry/resume are not one coherent surface. |
| Control | Per-member mention requirement with optional untagged follow-ups; configuration/disconnect controls. | No documented backend cancellation or token/tool streaming in this Slack implementation; no Slack stop/steer/queue control set. |
| Concurrency | Operations explicitly retain queue concurrency one pending durable leases. | Potential queue delay must be measured separately from model execution. Do not simply raise concurrency to hide it. |

Local evidence: [conversation.ts](../../apps/slack/src/conversation.ts), [progress.ts](../../apps/slack/src/progress.ts), [thread-status.ts](../../apps/slack/src/thread-status.ts), [failures.ts](../../apps/slack/src/failures.ts), [turn-errors.ts](../../apps/slack/src/turn-errors.ts), [interactions.ts](../../apps/slack/src/interactions.ts), [workspace-link.ts](../../apps/slack/src/workspace-link.ts), [operations](../cloud/slack-app-operations.md).

## Proposed Zuse experience

Everything in this section is a recommendation, not implemented behavior or a competitor guarantee.

### What a twenty-minute task should feel like

| Moment | Visible behavior | Why |
| --- | --- | --- |
| Accepted | One persistent receipt: task, repository/base branch, agent/model, execution identity, context/attachment counts, View in Zuse. | Confirm the target and give access before waiting. |
| Queued | Say queued, show elapsed queue time; show position/ETA only if reliable data exists. | Separate scheduling delay from an agent doing work. |
| Starting | Show actual provisioning/install/auth phase and any blocked setup action. | Avoid calling setup delay “thinking.” |
| Investigating | Brief factual milestone: what was checked and the finding, with details behind a worklog link. | Give useful context without flooding chat. |
| Editing/testing | Update the same card with current step, completed steps and evidence; attach meaningful screenshots/previews. | Make work reviewable while it proceeds. |
| Waiting for a person | Mark Needs your input; ask one concrete question with an authorized action; mention the responsible requester. | A run needing attention should not look busy. |
| Waiting externally | Name the command/check/service and last confirmed event time. | Explain a quiet period without inventing progress. |
| Lost contact | Show last confirmed progress and “Checking connection”; reconcile run state before offering a restart. | Avoid duplicate work when the worker is merely unreachable. |
| Done | Concise outcome, actual checks, PR/preview, caveats and continuation action. | Reduce reconstruction/review effort. |
| Failed/cancelled | Preserve work/link; identify phase/cause and whether work continues elsewhere; offer appropriate recovery. | A delivery error must not falsely imply execution failed. |

Illustrative copy, not real run evidence:

> Fix checkout retry behavior · Running 12m 14s  
> `payments` · base `main` · selected agent/model · requested by Raj  
> Read 14 thread messages and 2 images; 1 file could not be read.  
> Completed: reproduced timeout; changed retry handling.  
> Now: running integration checks. Last confirmed activity 18s ago.  
> View in Zuse · Stop · Add instruction

Keep ordinary thread participation as the first usable surface. Add native task streaming where available. Explore code channels for multi-step work after the core lifecycle is reliable; migration needs an explicit notice, clear destination for replies, and access/archival behavior.

### Priority order

1. **Visibility and observability:** persistent receipt/fallback, early session link, resolved context, true phase, elapsed time and last confirmed event. Measure queue, provision, model and result-delivery delays separately.
2. **Questions and control:** detectable blocked/approval state; explicit cancellation with backend confirmation; steer/queue semantics and a clear acknowledgement of which run receives a follow-up. Preserve current account authorization policy.
3. **Recovery:** typed failures with one relevant repair action; resume existing work where supported; safe retry only after checking submission/execution state. Preserve prompt, attachments, context, run identity and partial artifacts.
4. **Review:** compact final summary, checks actually run, PR/check cards updated in place, previews/screenshots/video and worklog. Completion of a turn, creation of a PR and passing CI are separate facts.
5. **Expansion:** channel defaults, quick-answer route, personal/team permission controls, optional code channels, and narrowly scoped automations. Shared channel memory is a separate product decision with retention and access rules.

### Engineering implications inferred from the research

Keep orchestration in `apps/slack`, persistence/wiring in the API adapter, and provider execution in existing shared capabilities. Inspect the existing shared progress/event, attachment, failure and cancellation APIs before introducing anything new. Do not create a Slack-only execution engine or application behavior in contracts.

A durable run projection should associate installation generation, initiating identity/account scope, conversation, request/turn, workspace and visible message/stream identities. Apply ordered events idempotently; persist terminal state so late activity cannot revive a finished card. Reconcile on restart/reconnect and handle delivery failure separately from execution failure. Expose only progress facts available from the runtime; coarse states remain coarse until that event contract exists.

Before parallelizing queue work, implement durable per-thread/run ownership and test simultaneous replies, retries, account reconnects and webhook/poll races. Rate-limit/coalesce updates per installation, prefer meaningful transitions over constant new messages, and make final delivery retryable independently of agent execution.

These are proposed reliability requirements. Public competitor docs do not reveal their lease, queue, outbox or recovery implementations.

### Recovery cases to specify before implementation

| Failure | User sees | Safe next step |
| --- | --- | --- |
| Revoked Slack permission | Which capability failed; work's actual execution state | Reauthorize without starting a duplicate run |
| Missing provider login | Which selected agent needs reconnection | Reconnect with original request retained |
| Provisioning failure | Workspace setup phase and actionable cause | Repair/resume workspace when supported |
| Slack delivery failure, agent still working | Delivery delayed; work may continue | Reconcile and resend status/result only |
| Missing/denied history or image | Exact omitted context | Grant access or proceed with explicit reduced context |
| Agent crash/worker reconnect | Last confirmed step and preserved workspace | Resume if available; otherwise explicit new run with retained context |
| Rate limit | Quiet retry state, no repeated error replies | Honor retry timing and coalesce |
| Cancellation race with completion | One authoritative settled outcome | Reconcile backend outcome before claiming cancellation |

### Acceptance and measurement

Suggested targets are product goals to validate under load, not measured baselines: human-visible acceptance within 3 seconds at p95 under normal Slack availability; meaningful initial phase/context within 10 seconds when metadata is available; stale progress detected within 60–90 seconds of missing expected heartbeats. Do not fabricate a fresh heartbeat merely because polling ran successfully.

Track receipt latency, queue delay, provisioning duration, first useful progress latency, longest silent interval, time a blocker goes unseen, cancellation latency, duplicate executions, duplicate replies, completion delivery delay, and recovery success. Include phase-specific error rates and whether users resend or abandon tasks. A task's full duration alone does not measure the quality of waiting.

Behavior verification should cover twenty-minute work, native-UI rejection, missing image/history, revoked credentials, delayed webhooks, out-of-order events, crashes/reconnects, duplicate delivery, simultaneous follow-ups, cross-user authorization, Slack 429s, cancellation races and final-result delivery retries. No live regression verification was performed for this research-only change.

## Research gaps and a useful next validation round

Authenticated trials should run the same small fix, screenshot-driven UI change, long test job, mid-run correction and recoverable failure through each product. Record actual first acknowledgement, longest silence, context disclosure, stop behavior and final evidence. Obtain consent for any shared-channel or billed work. Public documentation cannot answer these empirically.

To diagnose the reported Zuse errors, correlate the original Slack thread/message with request, queue, workspace, turn and result-delivery records. Classify where time and failure occur before choosing performance fixes. This study establishes the target experience and likely visibility gaps; it does not establish the incident's root cause.

## Deliverable verification

- Rebased the existing branch onto fetched `origin/main`; branch name retained. No conflicts.
- Verified 16 local image files, their 16 gallery entries, and local Markdown links. Rendered and visually inspected the gallery in Chrome.
- `git diff --check` passed. Biome 2.5.3 reported zero applicable files for the Markdown research; it does not validate these documents.
- Attempted Slack type checking and behavior tests. They could not run because dependencies are absent (`tsc` and `vitest` not found). No application source changed; these results are not claimed as passing checks.
