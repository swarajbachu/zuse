# Parallel execution — handoff prompts

Five tracks can run **concurrently** now that the wire contract (PR0) and the server WS
transport are landed. Each prompt below is self-contained: paste it into a fresh agent
running in its **own git worktree** off `main`. Read the [shared preamble](#shared-preamble)
first — every track assumes it.

> Isolation: give each agent a separate worktree/branch so they don't collide. The
> "Don't touch" boundary in each prompt is what keeps their diffs non-overlapping; respect
> it and the five branches merge cleanly.

---

## Shared preamble (every agent must read)

```
You are working in the Zuse monorepo (Electron coding-agent app; package @zuse/server).
Repo: Bun workspaces + Turbo. apps/* and packages/* and infra/*. Effect.ts everywhere.

NON-NEGOTIABLE conventions:
- Effect-style I/O ONLY: wrap all I/O in Effect.try / Effect.tryPromise. No raw
  try/catch, no bare Promises, in driver/server code.
- apps/server imports NOTHING electron-specific (ADR 0007). Transports live under
  apps/server/src/transports/. Pure makeMainLayer(deps) factory.
- RPC contracts live in packages/wire (already transport-agnostic). Reuse types from
  @zuse/wire — do not redefine Message/Session/etc.
- Branch names + PR titles describe the FEATURE only. Do NOT name any external/reference
  repository anywhere — not in code, comments, commits, branch names, or PR text.
- Gate your work on: bunx turbo build lint check-types test (scoped to your package).
  Use the real package names: @zuse/server, @zuse/wire, renderer, desktop.

ALREADY LANDED (do not redo; build on these):
- packages/wire: MessageEnvelope { sequence, message }; optional `sinceSequence` on
  MessagesStreamRpc; ProviderKind ("desktop"|"ssh"|"cloud"); EnvironmentDescriptor /
  EnvironmentEndpoint; connect.describe/linkProof/relayConfig RPC defs (in connect.ts,
  exported, NOT yet registered in MemoizeRpcs); EnvironmentId branded id.
- apps/server/src/transports/ws.ts: wsServerProtocolLayer({port,host}) — RpcServer over
  @effect/rpc socket-server protocol + NodeSocketServer.layerWebSocket, JSON framing,
  orDie'd into MainLayerDeps.serverProtocol.
- apps/server/src/bin.ts: runHeadlessServer() — headless `zuse serve` (file-backed
  AppPaths from env/XDG, no-op FolderPicker, WS transport), NodeRuntime.runMain, guarded
  by an entrypoint check so importing stays side-effect free.

RUNTIME FACTS (verified):
- The headless server must run on NODE, not Bun (better-sqlite3 is unsupported in Bun).
- better-sqlite3 is a native addon ABI-locked to one runtime; the Electron prebuild
  (NODE_MODULE_VERSION 130) is rejected by system Node (131). DECISION: migrate the
  persistence driver to Node's built-in `node:sqlite` (see Track A). Until that lands,
  headless boot fails at DB init — expected.

Full spec: specs/remote-multiclient/README.md. Report back: branch name, files changed,
how you verified, and anything that blocks another track.
```

---

## Track A — Event sourcing + `node:sqlite`  (persistence foundation)

```
Branch: remote-multiclient-event-sourcing
Goal: migrate the persistence driver to node:sqlite, then retrofit event sourcing in
front of the existing tables so chats get a global monotonic `sequence` and clients can
resume gap-free.

Read first: specs/remote-multiclient/README.md sections D1, D2, Appendix A.1/A.2.
Anchor files: apps/server/src/persistence/* (db-path.ts, sqlite.ts, migrations.ts,
migrations/*), apps/server/src/provider/layers/message-store.ts (persistMessage,
startSubscription, streamMessages, broadcastMessage), apps/server/src/runtime.ts,
packages/wire/src/session.ts.

Step 0 (prerequisite): confirm Electron 42's bundled Node exposes `node:sqlite`
(added Node 22.5, unflagged 22.13/23.4). If yes, proceed. If no, STOP and report —
we fall back to a Node-ABI better-sqlite3 binding for headless instead.

Step 1 — driver migration:
- Replace @effect/sql-sqlite-node (better-sqlite3) with a SqlClient backed by node:sqlite.
  Keep the @effect/sql SqlClient interface so existing template-string queries + the
  SqliteMigrator keep working. Verify all migrations 0001..latest still apply and the
  existing app boots (in-process Electron path) unchanged.

Step 2 — events table (new migration 0020_events):
- events(sequence INTEGER PK AUTOINCREMENT, event_id TEXT UNIQUE, stream_kind, stream_id,
  stream_version INTEGER, type, occurred_at, actor, payload_json), index
  (stream_kind, stream_id, sequence), UNIQUE(stream_kind, stream_id, stream_version).
- ALTER TABLE messages ADD COLUMN sequence INTEGER; backfill one synthetic
  MessagePersisted event per existing row in (created_at, rowid) order, stamping sequence
  on both event and row. Must run before any client connects (migrator already runs
  upstream of MessageStore).

Step 3 — write path:
- Add appendEvent({streamKind,streamId,type,payload,actor}) that, in ONE transaction,
  inserts the event (stream_version = MAX+1) and calls projectEvent in the same txn.
  Retry on the unique(stream_version) violation. projectEvent for MessagePersisted = the
  CURRENT messages INSERT + sessions.updated_at + chats.last_message_at writes.
- persistMessage keeps its signature; it routes through appendEvent and returns the
  assigned sequence alongside the Message. v1: route ONLY MessagePersisted through events.
  Leave queued_messages as CRUD (do NOT route the queue through events — it uses lazy DDL
  outside the migrator).
- Add a ProjectorCatchup layer in runtime.ts (between the migrator and MessageStore) that
  replays events past max(messages.sequence) on boot.

Step 4 — cursor streaming (PR-A2):
- Flip MessagesStreamRpc.success from Message to MessageEnvelope in packages/wire.
- Rewrite streamMessages(sessionId, sinceSequence): subscribe to the per-session
  PubSub<MessageEnvelope> BEFORE selecting rows WHERE sequence > since ORDER BY sequence;
  compute lastReplayed from replayed rows; Stream.concat(replay, live.filter(e.sequence >
  lastReplayed)). broadcastMessage publishes the envelope AFTER commit.
- Update the single renderer consumer of messages.stream to unwrap .message and record the
  highest .sequence per session, passing it back as sinceSequence on resubscribe.

Verify: migrations apply on a fresh DB AND an existing DB; property test "replay events
from 0 reproduces the messages projection"; reconnect test (stream → drop → resubscribe
with sinceSequence → zero gaps/dupes) using the in-memory sqlite mode; the Electron app
still boots and streams a chat end-to-end.

Don't touch: apps/renderer/src/lib/rpc-client.ts transport selection (Track B), anything
under apps/mobile, packages/ssh, infra/relay.
Coordinate: you and Track B both edit packages/wire/src/session.ts — you flip the
messages.stream success type; B only reads wire. Land the wire flip in your branch.
```

---

## Track B-renderer — browser/renderer WebSocket client

```
Branch: remote-multiclient-ws-client
Goal: let the renderer talk to @zuse/server over WebSocket (browser mode) while keeping
the Electron IPC path for the desktop. Server WS transport is already done.

Read first: specs/remote-multiclient/README.md Appendix A.3.
Anchor files: apps/renderer/src/lib/rpc-client.ts, apps/renderer/src/lib/
electron-client-protocol.ts (template), apps/renderer/package.json.

Tasks:
- Add @effect/platform (catalog) to renderer deps; bun install.
- New apps/renderer/src/lib/ws-client-protocol.ts:
    wsClientProtocolLayer(url) = RpcClient.layerProtocolSocket()
      |> Layer.provide(Socket.layerWebSocket(url))
      |> Layer.provide(Socket.layerWebSocketConstructorGlobal)
      |> Layer.provide(RpcSerialization.layerJson)
- In rpc-client.ts getRuntime(): pick Electron vs WS by presence of
  (globalThis.window?.zuse ?? globalThis.window?.memoize). WS URL from
  import.meta.env.VITE_ZUSE_WS_URL, default `ws://${location.host}/rpc`. Do NOT call
  getBridge() in WS mode (it throws when no bridge).

Verify: with the desktop Electron app, the IPC path is unchanged (regression check). Boot
`zuse serve` (note: needs Track A's node:sqlite to reach a working DB; until then verify
the layer compiles + the runtime selects WS when window.zuse is absent — e.g. a Vite
browser build pointed at VITE_ZUSE_WS_URL).

Don't touch: apps/server/*, packages/wire/* (read-only), apps/mobile, packages/ssh,
infra/relay. You only read MessagesStreamRpc; Track A owns the success-type flip.
```

---

## Track F — Mobile app (Expo) scaffold

```
Branch: remote-multiclient-mobile
Goal: an Expo app that drives the same wire RPC over WebSocket, pairs to a desktop on the
LAN via QR + bearer token, and renders chats (read-only first, then interact).

Read first: specs/remote-multiclient/README.md Workstream F, D3 (environment abstraction).
Use the expo-app-design skills for scaffolding.

Tasks:
- New apps/mobile (Expo Router). Add to workspaces.
- WS RpcClient runtime importing MemoizeRpcs from @zuse/wire directly (the contract is
  transport-agnostic — reuse it, do not redefine types). Browser WebSocket via
  @effect/platform Socket layers (mirror Track B's ws-client-protocol).
- Pairing screen: scan QR `zuse://?pairingUrl=<host>#token=<code>`; store the connection
  (host + bearer token) in expo-secure-store; a connection catalog keyed by environmentId.
- Offline: cache shell/thread snapshots as JSON in expo-file-system; on launch render the
  snapshot, then reconcile against the live stream using sinceSequence (the envelope carries
  it once Track A lands; until then stream from the beginning).
- Chat views: list sessions, render a message stream (read-only first).
- Phase 2 (PR-F2): send / approve / answer-question / interrupt.

Server to test against: run `zuse serve` on the LAN with a bearer token (pairing endpoint
arrives with Track C; until then use a temporary static token / mock). You can build the
entire client and UI against a mocked RpcClient before the server pairing endpoint exists.

Verify: Expo Go on a phone on the same LAN; QR-pair to a desktop WS; view a live chat;
airplane-mode → snapshot renders → reconnect reconciles.

Don't touch: anything outside apps/mobile/** except adding the workspace entry. Treat
packages/wire as read-only.
```

---

## Track G — SSH remote dev-boxes

```
Branch: remote-multiclient-ssh
Goal: the desktop launches the headless `zuse serve` on a remote machine over SSH and
tunnels back, so the renderer can drive a remote environment at ws://127.0.0.1:<local>/rpc.

Read first: specs/remote-multiclient/README.md Workstream G, D5. bin.ts already provides
the headless server to launch remotely.

Tasks — wrap the NATIVE ssh binary (no ssh2 library):
- New packages/ssh with modules: command (ssh -G resolve + run), auth (BatchMode key auth,
  SSH_ASKPASS password fallback caching a per-connection secret), config (parse ~/.ssh/
  config + known_hosts for host discovery), tunnel (-N -L 127.0.0.1:local:127.0.0.1:remote
  with ServerAliveInterval; Effect Scope finalizers SIGTERM→SIGKILL), errors.
- Remote launch script piped over `ssh user@host sh -s -- <stateKey>`: pick a free port,
  detect Node (nvm/volta/asdf/fnm/nodenv/system), run `zuse serve` on 127.0.0.1:<port>
  under ~/.zuse, HTTP-readiness-probe, print {remotePort, serverKind}. Reuse a running
  server if healthy.
- apps/desktop/src/ssh/: an environment service + IPC methods (host discovery, ensure
  environment → returns {wsBaseUrl: ws://127.0.0.1:<local>/rpc, ...}). Register the env
  with providerKind "ssh".

Verify: `ssh -G` resolves a fixture host; on a real remote box, launch + tunnel + drive a
chat; kill the tunnel → assert Scope teardown removed the remote process + local forward.
Note: the remote `zuse serve` depends on Track A's node:sqlite to reach a working DB;
until then verify launch/tunnel/readiness wiring against a stub `zuse serve`.

Don't touch: apps/server persistence/message-store (Track A), apps/renderer transport
(Track B), apps/mobile, infra/relay.
```

---

## Track D — Relay (cloud control plane)

```
Branch: remote-multiclient-relay
Goal: a standalone control-plane service that links devices↔environments, issues
short-lived connect tokens, and (later) fans out push. NOT in the data path.

Read first: specs/remote-multiclient/README.md Workstream D/E, D4. Identity is WorkOS
(reuse the existing login model; do NOT introduce Clerk). Device auth is DPoP
proof-of-possession; the environment proves control by signing a relay challenge with its
local bearer token (the connect.linkProof / connect.relayConfig wire defs already exist).

Tasks — new infra/relay (Cloudflare Worker + a managed SQL store):
- Endpoints: POST /v1/client/environment-link-challenges, POST /v1/client/environment-links,
  GET /v1/environments, POST /v1/environments/{id}/connect (→ short-lived DPoP token +
  managed endpoint), POST /v1/mobile/devices, POST /v1/environments/{id}/agent-activity.
- Key everything by environmentId (never "this laptop") and carry providerKind +
  EnvironmentEndpoint so desktop/ssh/cloud are uniform.
- Managed tunnel (PR-E, can be a follow-up): provision a Cloudflare Tunnel connector token;
  map environmentId → tunnel hostname; the desktop runs the connector pointed at its local
  WS server; mobile connects to that hostname with the DPoP connect token.

Build standalone against a stubbed environment + stubbed WorkOS verification; integrate
with Track C (auth) when it lands.

Verify: link a stub environment, fetch a connect token, assert tokens are short-lived and
scoped; assert no chat bytes traverse the relay (data path is direct client↔environment).

Don't touch: anything outside infra/relay/** (and, later, a small desktop connector under
apps/desktop for the tunnel — coordinate with Track G's desktop changes to avoid overlap).
```

---

## Merge order

A and B both edit `packages/wire/src/session.ts` (A flips `messages.stream` success →
`MessageEnvelope`; B only reads it). **Land A's wire flip first**, then rebase B. F, G, D
touch disjoint trees (`apps/mobile`, `packages/ssh`, `infra/relay`) and merge in any order.
C/E/H come after their dependencies (auth → tunnel → push). I (cloud provisioner) is deferred.
