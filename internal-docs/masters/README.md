# Zots

A **Zot** (plural **Zots**; the Z is for Zuse) is a persistent coordinator and its delegated agents stay **Slaves**. Code, contracts, RPCs and storage keep the `master` names.

Zots coordinate ordinary Zuse conversations across selected repositories and authenticated environments. A Zot owns durable policy, objectives, notes, decisions, artifact versions and coordinator history. Its private workspace is separate from managed repositories and hidden from ordinary repository navigation.

The coordinator delegates repository implementation through the Zuse CLI (or `master_action`), including small changes. It can plan, inspect progress, coordinate workers, and maintain private notes and artifacts; it must not edit managed repositories or take over blocked implementation. Continuations reuse suitable supervised workers. The CLI exposes `master state --session <id>` and `master action --session <id> --command-id <id> --json @action.json` through the same scoped router and permissions as MCP. This role is injected into native provider instructions on startup/resume and written into the private workspace on creation, renewal, and configuration changes.

This implementation replaces the coordination scope in `specs/self-orchestration`. It retains the existing provider tools, chat/session boundaries, worktree creation, command receipts and permissions. Cross-machine coordination, previously deferred there, is part of Zots. Scheduled work, reminders, PR repair/review loops, external harnesses and social monitoring remain separate features. Zuse uses its own server, transport and UI for worker visibility, durable recovery and escalation.

For the MVP release boundary, local/cloud storage plan and Codex/Opus implementation handoff, see [the rollout plan](rollout-plan.md).

## Preview deployment boundary

The first Preview enables coordination within the selected home environment. Generated HTML execution, cross-environment dispatch and home transfer are disabled on the server by default and unavailable in the native UI; missing capability metadata also means disabled. Repository selection is restricted to the home. Existing remote references remain inspectable and are not silently detached.

`ZUSE_MASTERS_CROSS_ENVIRONMENT=1` is an operator opt-in for authenticated staging validation, captured when the server starts. Enable it only on compatible, deployed homes/workers after the authority API migration/routes and linked-environment smoke checks pass. It does not bypass permissions or account/generation checks. The default local mode does not register new Zots with the account control plane, allowing local work while those API changes remain undeployed. Account-managed records retain their existing ownership checks.

Fresh chats preserve the active coordinator provider/model. Explicit Preferences changes take precedence; command retries reuse the already-created coordinator instead of creating another one.

## Ownership and interfaces

- `packages/contracts/src/master.ts` defines lifecycle actions, repository bindings, environment-qualified workers, summaries, shared artifacts and peer operations.
- `apps/server/src/master/service.ts` owns lifecycle, delegation, supervision, recovery and transfer. `store.ts` owns SQLite transactions and receipts; `peers.ts` owns scoped authenticated HTTP peer transport; `state.ts` owns bounded checkpoints and execution policy.
- `infra/api/src/master-routes.ts` fences account-managed ownership with a generation. Claims serialize by account and enforce exclusive repository/environment bindings. Server registry migration 0090 and API migration 0047 are additive.
- `apps/renderer/src/lib/masters-client-bus.ts` owns shared directory/summary subscriptions. Native controls and generated-screen requests dispatch the same environment command bus. Provider tools call the same server lifecycle module.

A repository binding has one owning Zot. Selection observes existing and future chats without sending instructions. Removing a binding detaches its worker references and cancels queued delegation and instructions for that repository; it never deletes chats or worktrees. Workers retain their original environment, chat and session identity. Remote attribution is descriptive metadata, without cross-database foreign keys.

The account ownership endpoint must be deployed before account-managed or cross-environment Zots can use it. Local-only Zots work without account registration when the API has not deployed the Zots endpoint (HTTP 404). Other account failures remain errors; remote repositories always require ownership registration. Account validation precedes saving a new Zot, and older incomplete records reopen in settings for recovery. Linked peers obtain short-lived Zot/destination grants using their environment credentials. These grants have a dedicated JWT type and endpoint, cannot authenticate to ordinary app RPC, and bind worker reports to their source environment. Credentials stay inside the server transport.

## Conversation and supervision

The Zot opens into one active ordinary coordinator session, with no right utility panel. A fresh chat or configuration change checkpoints durable work, preserves the old transcript and creates a compatible provider session. An active coordinator turn must finish or be explicitly interrupted first. Existing workers continue, and future supervision addresses the active coordinator. Context growth produces a suggestion, never automatic renewal.

Independent delegation creates a deterministic chat/session/worktree; a supplied chat ID creates another session tab in that checkout. Automatic messages require a supervised objective. Merely observing a repository grants no objective or permission to continue existing work.

The server reconciles durable event sequences every three seconds. It wakes an idle coordinator for worker settlements and permission events, batching accumulated events while it is busy. Execution uses durable turn events: a live provider process is not a working turn, and a settled turn is not task completion. Unknown disconnected turns reserve capacity. Defaults are four concurrent delegated turns and three automatic follow-ups per objective. Settings live in the Zot's Details panel (see Views). Skills are picked from the home environment's installed skills. The former model-guidance text is shown inside Instructions and saved there on the next save. Model inventories are fetched and cached per home environment. Creation starts with the user's configured default; editing reads the active coordinator's actual model. Task-oriented profiles pair a task description with an explicit provider/model from the home catalog; unavailable choices remain visible.

Pause prevents further automatic dispatch while workers may finish their current work. Stop additionally cancels queued commands and persists interruption deliveries, including disconnected workers and the coordinator. Interruption receipts retry across reconnects. An unacknowledged delegation is reconciled with a destination cancellation tombstone; a delayed request cannot create a replacement. Permission denial and manual interruption pause the objective and prevent automatic follow-up until the user resumes it.

Command IDs and canonical fingerprints identify retries. State mutations and their receipts commit together. Destination receipts, deterministic session identities, source pending commands, worker event cursors and interruption deliveries survive renderer and server restarts. Provider permission policy and Plan mode still govern mutations. Delegation grants no merge, deployment or discard authorization.

## Learned memory

The Details panel includes versioned learned-memory topics and optional bounded consolidation of submitted findings. Memory stays separate from user policy and live task state. Workers retrieve topics on demand; fresh-chat checkpoints carry the compact index instead of replaying consumed findings. See [memory implementation and recovery](memory.md) for provider support, limits, provenance and validation.

## Moving home

Both environments must be online. The source probes the destination, pauses dispatch, stages the Zot record, revision history, all artifact versions, transcripts, command receipts and interruption records, then compares and swaps account ownership. The destination verifies scope and artifact contents and starts a fresh coordinator. Workers stay in their original environments.

The source keeps a durable transfer journal until activation is acknowledged. Interrupted transfers retry with the same command identities. The generation prevents the old home from dispatching after the account switches ownership. There is no automatic migration or failover; coordination requires the selected home to run. Failed or pending operations remain visible in the slaves rail.

## Views and generated screens

The first visit to a Zot includes a five-step guide: the coordinator's role, repository scope, writing a brief, inspecting delegated Slaves, and preserving work through fresh chats. Pointers identify the corresponding controls. The guide is informational: it does not send messages, grant permissions, create workers or change repository bindings. Users can skip it and replay it from the Zot menu. Progress is a versioned device-local renderer preference, independent of coordinator memory and server state; unavailable or malformed browser storage does not block the app.

The Zot screen is the coordinator conversation with a resizable Details panel on the right (280–560px, toggled from the header). Its composer is the shared one in its minimal form: attachments, the model picker (models can change mid-chat) and send. Each Zot has a pixel-art mascot (`components/masters/mascot.tsx`; editable ASCII sprites in `mascot-sprites.ts`) chosen from five shapes and eight colours; its state — idle, working, needs you, done, paused — is shown by sprite frames and 1-pixel stepped CSS motion that respects reduced motion. `+` in the sidebar creates a Zot immediately with a generated name, a random mascot and the user's default model, and opens it. An empty conversation shows the mascot, its name and the composer. Details shows the name and mascot (edited once and saved through the `appearance` action), then repositories with GitHub owner avatars (saved instantly through the `repositories` action; neither starts a fresh chat), where it runs, and rows for Slaves, Memory and Pinned that push a sub-view in from the right. Preferences — instructions, skills (searchable, with switches), models for specific work and limits — open as a page in the main area and save together with `configure`, which starts a fresh chat; the page says so before saving. Artifacts open in a side panel that replaces Details; previous conversations open from the header menu.

Slave status comes from durable turn events in the chat summaries, never from Git state: PR, CI and mergeability do not establish objective completion or merge approval. Offline slaves are shown explicitly.

Todos, decisions and notes retain authorship in the Zot revision log; they remain available to the coordinator and generated screens but have no native view. Workers publish separate findings and cannot overwrite user policy. Artifact versions are immutable and can be read individually across environments. Publishing does not synchronize worktrees. The conversation can show pinned artifacts; detailed screens and history transcripts load on demand.

Generated HTML execution is disabled in this Preview: artifacts remain stored, but no iframe or bridge is mounted. The experimental runtime must gain enforceable network isolation before re-enabling it. Its implementation uses an opaque-origin sandboxed iframe with scripts enabled and no app origin, popups, forms or top-level navigation privilege. A restrictive CSP blocks fetches, external resources and nested frames. `window.zuseMaster.read()` returns only the selected Zot's summary; `requestAction(action)` and `openChat(environmentId, chatId)` request native actions through a dedicated MessageChannel. Mutations require an explicit native Run action, then the server validates the scope again. Rendering alone is never approval. Hiding, navigation or failure revokes the channel; native navigation and controls remain available.

## Validation

Behavior coverage lives in:

- Server integration: `masters-store.test.ts` and `masters-supervision.test.ts` (exclusive bindings, atomic receipts, artifact versions, local/cloud simulation, lost acknowledgments, interrupted transfers, fresh conversations, concurrency, cancellation and permission denial).
- API unit: `master-ownership.test.ts` (ownership races, binding exclusivity and account isolation).
- Renderer unit: `master-activity.test.ts` (slave activity derivation and screen CSP).
- System: `masters.system.test.ts` (real RPC/server restart, private workspace, history, decisions, artifact retrieval and receipt replay).

Browser validation uses an isolated `.context/masters-qa` server with 100 ordinary chats. Summary loading does not fetch transcripts or artifact contents. The measured summary RPC for that fixture was approximately 60 ms. Six concurrent subscriptions received their initial and updated 100-chat summaries in about 2.5 seconds. The sandbox was checked for denied parent-document access and native approval before mutations.

Real paid model delegation and production cloud credentials are separate deployment smoke checks; simulated peers exercise recovery without paid model calls. Translation additions follow the desktop projects namespace in all seven supported locales, with machine drafts left unreviewed.

### Current validation

The October 22 candidate passes 1,652 server tests, all 2,056 renderer unit tests, renderer/server types, architecture, localization, production renderer build budgets and the actual Stable → candidate → Stable → candidate data probe. Native Electron cold start and chat creation/interruption pass after correcting package-entry metadata and dynamic-port allocation. The remaining chat/relaunch scenario currently stops at command-palette assertions; it is not a desktop pass. Broader API deployment/recovery fixtures also fail and are being compared against main. See [validation](validation.md) for current limitations.
