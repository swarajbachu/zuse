# Coding agents in Slack: competitor evidence

Research date: 2026-10-24. Public first-party documentation and announcements only. This is a feature audit, not an authenticated product trial or an independent latency benchmark. Product behavior below is **documented**, except where explicitly labeled inference or unknown. Availability and rollout differ by workspace.

## What changed recently

An evaluation based only on 2025 thread bots misses the current product direction. GitHub announced its new experience on August 21, 2026, including collaborative code channels, diffs and HTML previews. Anthropic introduced Claude Tag on June 23, 2026; its Help Center says the earlier Slack experience switched on August 3. Do not combine the legacy individual-account Claude integration with the shared-identity Tag product in one feature column. [GitHub announcement](https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack/), [Anthropic announcement](https://www.anthropic.com/news/introducing-claude-tag), [migration overview](https://support.claude.com/en/articles/15594475-what-is-claude-tag).

## Devin

Documented on [Devin's Slack integration page](https://docs.devin.ai/integrations/slack):

- Start with `@Devin`, including attachments; continue in-thread.
- `!ask` and `/ask-devin` answer codebase questions without a full agent run. Message shortcuts support quick questions and a prefilled session modal with channel/playbook selection.
- `mute` stops thread ingestion; `unmute` resumes; `!aside` excludes one message. `sleep`, `archive`, and `EXIT` control session lifecycle. Mentioning an archived session reopens it.
- Modes include fast, lite, ultra and others, with mid-session switching. `!new`, `!channel`, OS and Outpost options control placement.
- Web sessions and Slack threads can sync bidirectionally; `!unsync` disconnects them. Environment proposals can expose a diff and Apply action.
- Code channels expose working/blocked/done state, session link, PR chips/tabs and live thoughts/tool worklog. Channel messages reach the session without mentions.
- Sessions can move from a thread to a code channel; the original thread receives a move notice and stops forwarding replies. Without membership in the source conversation, Devin explicitly says its context is only the quoted message.
- Code channels depend on Slack's gradual feature rollout. Installation and per-user profile linking are separate steps.

**Unknown:** guaranteed first acknowledgement latency, update cadence, queue estimates, automatic recovery semantics, durable delivery/outbox implementation. No public backend architecture was established by this research.

## Cursor Cloud Agents

Documented on [Cursor's Slack page](https://prod.cursor.com/docs/integrations/slack):

- `@Cursor` starts work using the whole thread; an existing thread receives follow-ups. `agent` forces a new run. DMs support new top-level tasks and thread replies.
- Prompt options select repo/environment, branch, model, PR creation, machine/pool and output channel. Repository inference also uses recent activity, routing rules and defaults.
- Channel defaults and explicit overrides reduce repeated setup. Follow-up authorization is configurable for the team.
- A short plan appears for bugs or work needing implementation context; a live status appears under the thread. Initial handoff offers Open in Cursor; completion notifies Slack and links the PR.
- `list my agents` exposes running work. Message menus provide targeted follow-up, stop/archive, feedback and request ID for support.
- Switch repository starts a fresh agent; existing changes do not transfer and the old branch/PR remain.
- Summary/diff visibility can be disabled, including separately for external channels. Setup includes repository provider, pricing and privacy choices.

**Unknown:** exact update frequency, time-to-first-useful-result, restart/reconnect behavior, idempotency and automatic retry policies. A request ID is documented; it does not establish that every failure has a one-click retry.

## Factory Droid

Documented on [Factory's Slack delegation page](https://docs.factory.com/delegations/slack):

- Channel mentions use a configured service account; DMs use personal identity/connectors. Each delegating user needs a matching Factory account.
- Thread history and supported images provide context. Follow-ups and attachments reach active sessions; generated files, artifacts and result videos return to Slack. CI can run in a subagent for responsiveness.
- Shared execution settings cover model/reasoning, instructions, plugins, identity and compute.
- Substantial work can move into code channels; small questions stay in threads. `!new` requests a channel. A move notice directs follow-ups to the new location.
- Code channels show current repository/branch and branch diff. Potential secrets, binary or oversized diffs produce a notice instead.
- Questions appear in-channel. Final wrap-up includes outcome, PR links and remaining work before user-requested archival. Inactivity triggers a warning after seven days and archive 24 hours later unless someone responds.
- `!connect` provides SSH instructions; `!help` lists commands. Attachment or code-channel capabilities may require reauthorization.
- Session links are provided for personal runs, but withheld for channel service-account runs.

**Unknown:** durable event reconciliation, acknowledgement SLA, stalled-run detection threshold and automated recovery policy. Code channels require Slack availability.

## Claude Tag: current team experience

The [Anthropic launch](https://www.anthropic.com/news/introducing-claude-tag) documents shared channel identity, staged task execution, channel memory, asynchronous work over hours/days, optional ambient follow-ups, and personal DMs. Administrators scope tools and memories, set organization/channel spending limits, and inspect activity with requester attribution. Treat these as vendor-described capabilities, not proof of reliability under failure.

The [Help Center overview](https://support.claude.com/en/articles/15594475-what-is-claude-tag) identifies Team/Enterprise beta availability and three surfaces: channel mentions, DMs, and an assistant side panel. Anyone in a channel can steer shared work. Shared-channel tasks use organizational access/billing; personal DM/panel capabilities differ.

The [admin guide](https://academy.claude.com/tutorials/claude-tag-admin-guide) adds operational detail:

- Shared connections belong to Claude; personal connectors remain separate, with explicit permission for personal-task use in channels.
- Access bundles compose across organization, workspace and channel scopes. Narrower grants add access; they do not subtract inherited access.
- Narrowest-scope credentials win for a host, without silent fallback after a 401/403.
- A running thread retains its original instructions/plugins/skills; connections and domain rules apply per request. Configuration changes should be checked in a new thread.
- Admins control who can invoke it, where it answers and what it can access independently; guest and Slack Connect behavior has distinct controls.

**Unknown:** end-to-end error recovery SLA and precise heartbeat policy. Shared memory is a larger product commitment than simply fetching a thread; its scope and controls must be designed explicitly.

## Earlier Claude Code in Slack: separate legacy comparison

[The legacy integration docs](https://code.claude.com/docs/en/slack) now specify Pro/Max accounts in workspaces not connected to Claude Tag. Sessions use individual identity, connected repositories and limits. It supports channels rather than DMs.

Code-only mode routes every mention to coding; Code + Chat classifies requests, with Retry as Code correcting routing. Entire threads or relevant recent channel messages supply context. Repository selection can be corrected through Change Repo/dropdowns. Slack shows progress, then mentions the requester with a summary, View Session and Create PR actions. Full transcripts and continuation live on the web.

**Design lesson (inference):** classification and repository inference need visible correction controls; relying on inference without showing the chosen target creates avoidable uncertainty.

## GitHub Copilot cloud agent

[Current GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack) describe public-preview Slack sessions for investigation, planning, coding, issues and PRs. The entire conversation becomes artifact context; DMs limit shared context. Personal DMs use the linked user, shared conversations use the app identity. Starting changes requires write access; guests and outside collaborators cannot start or steer sessions.

One code channel represents one session. It displays repo, branch, issue/PR, status and model. After migration, steer through that channel. Completed channels can be archived while preserving searchable history and later reopened. Repository/branch can be specified naturally, and channels can share repository defaults. Issue creation supports multiple issues and parent-child relationships.

The [August announcement](https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack/) additionally documents collaborative plans, diffs, HTML artifact previews, joining from the original thread, redirecting and stopping a session. It describes Business/Enterprise preview availability; the newer integration docs say all paid plans. Use the current docs and verify eligibility in the actual organization instead of treating these two statements as interchangeable.

**Unknown:** precise status cadence, wait estimates, transport retry mechanics and resumption behavior after sandbox failures.

## What this suggests for Zuse (recommendations, not competitor claims)

1. Treat Slack as a durable task interface. Show the resolved repo, branch, agent/model, scope and session link before lengthy work starts. Summarize what context was included, and make omissions explicit.
2. Distinguish queued, provisioning, investigating, editing, testing, waiting for user, retrying, failed, cancelled and done. A generic spinner cannot explain a 20-minute run.
3. Keep one compact status surface current. Post milestone replies when something materially changes; reserve mentions for a question, blocker or result. Preserve a full transcript/worklog behind a link.
4. Separate quick codebase answers from cloud implementation. Ask-mode should not pay for full workspace startup when unnecessary.
5. Provide steering, cancellation, retry/resume and an explicit new-session action. A reply must clearly say which run receives it, especially when a thread contains multiple runs.
6. Make errors actionable: phase, safe human-readable cause, retained work, next action and diagnostic ID. Do not reset context when recovery is possible.
7. Finish with outcome, verification evidence, PR/preview/media links, and any unresolved work. Demo evidence reduces the reviewer's reconstruction cost.
8. Consider Slack Code after the core thread experience works. It offers a richer native surface but is rollout-dependent and adds migration, permissions and archive lifecycle requirements.

These are inferred design priorities. No competitor source establishes that a specific heartbeat interval or retry algorithm is the correct one for Zuse. Measure acknowledgement latency, queue/provisioning time, longest silent interval, blocked-time visibility, duplicate runs/messages and completion-delivery failures in our own system.

## Visual evidence inventory

These are publisher-hosted reference assets, not screenshots captured from authenticated accounts. They may show older UI than the latest prose. Preserve provenance and do not infer unseen states from the image alone.

| Asset | Publisher/source page | Direct asset |
| --- | --- | --- |
| Devin invocation | [Devin Slack docs](https://docs.devin.ai/integrations/slack) | [slack_message.png](https://docs.devin.ai/images/slack_message.png) |
| Devin thread conversation | [Devin Slack docs](https://docs.devin.ai/integrations/slack) | [slack_chat.png](https://docs.devin.ai/images/slack_chat.png) |
| Devin channel example | [Devin Slack docs](https://docs.devin.ai/integrations/slack) | [slack_channel.png](https://docs.devin.ai/images/slack_channel.png) |
| Devin rename example | [Devin Slack docs](https://docs.devin.ai/integrations/slack) | [slack_rename.png](https://docs.devin.ai/images/slack_rename.png) |
| Cursor initial handoff | [Cursor Slack docs](https://prod.cursor.com/docs/integrations/slack) | [slack-open-in-cursor.png](https://prod.cursor.com/docs-static/images/cloud-agent/slack/slack-open-in-cursor.png) |
| Cursor completion | [Cursor Slack docs](https://prod.cursor.com/docs/integrations/slack) | [slack-view-pr.png](https://prod.cursor.com/docs-static/images/cloud-agent/slack/slack-view-pr.png) |
| Cursor controls | [Cursor Slack docs](https://prod.cursor.com/docs/integrations/slack) | [slack-context-menu.png](https://prod.cursor.com/docs-static/images/cloud-agent/slack/slack-context-menu.png) |
| Copilot code channel | [GitHub August 2026 announcement](https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack/) | [First-party image](https://github.blog/wp-content/uploads/2026/08/638619753-9a27284a-b9b0-4383-991b-068515859d0a.jpg) |

Additional first-party moving demonstrations: [Devin Slack bug-fix tutorial](https://docs.devin.ai/tutorial-library/slack-bug-fix), [GitHub official Slack tutorial, November 2025](https://www.youtube.com/watch?v=l37u8FrdhY0), [GitHub Slack landing page](https://slack.github.com/), [Claude Tag illustrated walkthrough](https://academy.claude.com/courses/introduction-to-claude-tag/tag-claude-and-see-what-happens). The 2025 GitHub video predates the 2026 code-channel release.

## Evidence limitations

Public product documentation exposes supported interaction patterns, not maintenance architecture, measured uptime, latency distributions or incident handling internals. No private Slack accounts were accessed, no production tasks were launched, and no comparative reliability claims were validated. The evidence supports UX and capability comparisons; it does not prove that any competitor is faster or more reliable in practice.
