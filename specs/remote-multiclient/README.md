# Remote & Multi-Client — Headless Server, Mobile, Cloud, SSH

Status: In progress
Started: 2026-06-30

Make Zuse drivable by the desktop, a **mobile app**, a **browser**, and **remote /
cloud dev-boxes** — all against the *same* `@zuse/server` over WebSocket, reachable from
anywhere, with clean reconnect and offline support.

This folder is the source of truth for the initiative. Companion docs:
- [`parallel-handoffs.md`](./parallel-handoffs.md) — ready-to-paste prompts + boundaries for running the independent tracks as parallel agents.
- `decisions/` — ADRs spun out of the locked decisions below (to be authored per workstream).

---

## 1. Guiding principle: additive, not a rewrite

`@zuse/server` is already an Effect app (`@effect/rpc`, `@effect/sql`,
`@effect/platform-node`). [ADR 0007](../0.01-MVP/decisions/0007-server-as-code-only-app.md)
already mandates **zero `electron` imports in `apps/server`**, a pure `makeMainLayer(deps)`
factory, and a **pluggable transport** (`electron-server-protocol.ts` implements
`RpcServer.Protocol`). `apps/server/src/bin.ts` was a stub explicitly reserved for the
headless WebSocket boot.

So "Electron backend vs a headless backend" is a non-issue — **the base server stays; we
add to it.** The only genuine architectural gap is persistence: today's direct CRUD +
in-memory PubSub gives the local renderer live updates but **cannot** give a mobile client
gap-free reconnect, offline snapshots, or multi-writer fan-out. Closing that gap is the
spine of this work.

---

## 2. Locked decisions

### D1 — Event sourcing for chat persistence
Introduce an append-only `events` table (global monotonic `sequence`) **in front of** the
existing tables. A **projector** derives `messages` / `sessions` / `chats` from events, so
those tables keep their exact shape and **every reader and the renderer stay essentially
unchanged** — `messages` effectively *becomes a projection*.

- **Why:** single source of truth; gap-free replay via a `sinceSequence` cursor (mobile
  reconnect/offline); deterministic rebuild ("drop `messages`, replay events"); natural fit
  with the existing turn/checkpoint model.
- **Tradeoff:** more upfront work in `message-store.ts`, and the discipline that **all
  writes go through events** (no in-place row mutation). Contained by keeping projections
  identical to today's tables, and by routing **only sessions/messages** through events in
  v1 (the queue stays CRUD — see R2).
- **Rejected:** a `sequence` column + change-feed on the CRUD tables (no event log). ~70%
  of the value for less churn, but keeps mutable truth (no clean replay/audit/rebuild) and
  forces a bespoke mobile sync layer. Not worth it for a multi-year foundation.

### D2 — Persistence driver: migrate to `node:sqlite`
**Replace `@effect/sql-sqlite-node` (better-sqlite3) with Node's built-in `node:sqlite`.**

- **Why (verified by booting `bin.ts` headless):** `better-sqlite3` is a native addon, so
  its compiled `.node` is **ABI-locked to one runtime**. The Electron prebuild
  (`NODE_MODULE_VERSION` 130) is rejected by plain system Node (131), and **Bun doesn't
  support better-sqlite3 at all**. A headless / SSH / cloud server therefore cannot reuse
  the Electron binding. `node:sqlite` is built into Node (≥22.5, unflagged from 22.13 /
  23.4) — **no native addon, no ABI split** — so the *same* persistence code runs under
  Electron's Node and under a headless Node identically. Its synchronous API is close to
  better-sqlite3, so the migration is mechanical.
- **Sequencing:** do this **inside the event-sourcing PR (Workstream A)**, since both touch
  the persistence layer — migrating the driver and adding the events table in one pass
  avoids editing `message-store.ts` / the migrator twice.
- **Prerequisite to verify first:** confirm Electron 42's bundled Node exposes `node:sqlite`
  (it should — Electron 42 ships Node 22+). **If not**, fall back: keep better-sqlite3 in
  Electron and ship a Node-ABI better-sqlite3 binding for the headless build. This fallback
  is strictly worse (two code paths) but unblocks if the Electron Node version is too old.
- **Scope note:** `@effect/sql`'s `SqlClient` interface and the template-string queries are
  driver-agnostic, so migrations and repositories should largely carry over; the work is a
  thin `SqlClient` implementation over `node:sqlite` (or adopting an existing
  `@effect/sql-sqlite-node`→node:sqlite shim if one fits).

### D3 — Environment abstraction (`providerKind`)
An **environment** is "a host running `@zuse/server`," a first-class entity with
`providerKind: "desktop" | "ssh" | "cloud"` and an endpoint `{ httpBaseUrl, wsBaseUrl }`.
Everything above the transport — persistence, projector, providers, **git worktree
management** — is host-agnostic (ADR 0007; worktrees are on-disk checkouts under the
project path). A **cloud worktree is therefore not a new code path**: it's the headless
server running on a cloud volume, registered with `providerKind: "cloud"`, reached via the
same link/connect + WS flow as desktop or SSH.

Design rules to hold from day one (so cloud drops in with no refactor):
- Nothing in `apps/server` assumes the worktree/project root is on the user's machine.
- The relay keys everything by `environmentId`, never "this laptop."
- Connect/link wire methods carry `providerKind` + endpoint.
- Worktree lifecycle stays a server-side RPC capability — clients never touch the filesystem.

### D4 — Cloud reach: WorkOS + thin relay + managed tunnel
Mobile reaches the desktop from anywhere via a **control-plane relay** that links
devices↔environments, issues short-lived connect tokens, and provisions a **managed tunnel**
(Cloudflare) — then steps aside. The relay is **never in the data path**; chat traffic goes
directly client↔environment over WS. Identity is **WorkOS** (reuse the existing login;
PKCE/keychain, `getAccessToken` seam), with a **device DPoP** proof-of-possession key and a
local bearer token proving environment control during linking.

### D5 — SSH remote dev-boxes: native `ssh` wrapper
The desktop launches the headless server on a remote machine and tunnels back, by wrapping
the **native `ssh` binary** (no `ssh2` library): `ssh -G` to resolve `~/.ssh/config`,
`BatchMode=yes` key auth with `SSH_ASKPASS` password fallback,
`-N -L 127.0.0.1:local:127.0.0.1:remote`, Effect `Scope` finalizers for teardown.

---

## 3. Target architecture

One server, multiple process shapes, multiple client surfaces, one control plane.

```
            ┌────────────────── Relay (control plane only) ──────────────────┐
            │  WorkOS identity · device↔environment link · short-lived tokens │
            │  managed-tunnel provisioning (Cloudflare) · push (APNs) fan-out │
            │  NOT in the data path — issues credentials, then steps aside    │
            └────────────────────────────────────────────────────────────────┘
               ▲ WorkOS JWT + device DPoP        ▲ link proof (local bearer)
   Mobile (Expo) ─┐                              │
   Browser ───────┤  WebSocket (RpcClient), direct to the environment
   Desktop ───────┤
                  ▼
         ┌──────── @zuse/server — "an environment" ────────┐
         │  events → projector → messages/sessions/chats    │   the SAME binary, by providerKind:
         │  (node:sqlite)                                   │     · desktop → laptop (IPC, or WS+tunnel)
         │  RpcServer.Protocol: Electron IPC | WebSocket    │     · ssh     → remote dev-box, tunneled
         │  providers · git · pty · worktrees               │     · cloud   → cloud container + volume
         └──────────────────────────────────────────────────┘        (cloud worktrees)
```

**Process shapes** (all from one `makeMainLayer(deps)`):
1. **In-process** — Electron today; `serverProtocol = electronServerProtocolLayer`. Stays working throughout.
2. **Headless WS** — `bin.ts` (`zuse serve`); `serverProtocol = wsServerProtocolLayer({port})`, file-backed AppPaths, no-op FolderPicker. One binary; runs on SSH dev-boxes and cloud containers.
3. **Remote-over-SSH** — shape 2 launched on a remote machine by the desktop, tunneled to `127.0.0.1:localPort`.
4. **Cloud-hosted** — shape 2 on a cloud container with a persistent volume (sqlite + worktrees), reached via the relay's managed endpoint.

**Client surfaces:** desktop renderer (IPC now, WS-capable), browser (WS), mobile Expo (WS), CLI (future, same WS client).

---

## 4. Workstreams

Effect-style I/O only — wrap all I/O in `Effect.try/tryPromise`, no raw try/catch.

| ID | Workstream | Goal | Reuse | Depends on |
|----|-----------|------|-------|-----------|
| **A** | Sync core (event sourcing + `node:sqlite`) | `events` table + projector + monotonic `sequence`; `streamMessages(sinceSequence)` gap-free resume; driver→`node:sqlite` | `message-store.ts`, the migrator, `@effect/sql` template queries | PR0 ✅ |
| **B** | WebSocket transport | server reachable over WS; headless boot; renderer can pick WS vs IPC | `electron-server-protocol.ts` template, `MainLayerDeps.serverProtocol` seam | PR0 ✅ (server side ✅ done) |
| **C** | Auth & pairing | LAN pairing (QR + bearer) + cloud identity (WorkOS) + device DPoP | existing WorkOS login, `credentials-service.ts` | B |
| **D** | Relay (control plane) | link devices↔environments, issue connect tokens, push fan-out | WorkOS as IdP | C |
| **E** | Managed tunnel | reach the desktop from anywhere (Cloudflare Tunnel) | — | B, D |
| **F** | Mobile app (Expo) | same wire RPC; QR pairing; cloud link; offline snapshots; full interact | **`packages/wire` types directly**, WS client from B | B (LAN), C/D (cloud) |
| **G** | SSH remote dev-boxes | launch headless server remotely + tunnel back | native `ssh` wrapper pattern | B (`bin.ts`) ✅ |
| **H** | Push & notifications | notify on approval/input/turn-complete/failure; iOS Live Activities | relay APNs | D, F |
| **I** | Cloud environments (deferred) | provisioner that boots `zuse serve` on a cloud container + volume | headless `bin.ts`, relay, `providerKind` seam | B, D |

Per-workstream file lists, code sketches, and risks are in [Appendix A](#appendix-a--core-design-file-grounded).

---

## 5. Parallelization map

```
PR0 wire-contract ✅ ── enables everything
   ├──► A  sync-core (event sourcing + node:sqlite)        ── persistence track
   ├──► B  ws-transport (server ✅) ─► B-renderer (WS client)
   │         └──► G  ssh (uses bin.ts ✅)
   │         └──► F  mobile (LAN/bearer) ─► C auth ─► D relay ─► E tunnel ─► H push
   └──► D  relay (standalone, stub env until C)
```

**Concurrent lanes (independent agents, worktree-isolated):**

| Lane | Track | Branch | Can start | Touches (conflict surface) |
|------|-------|--------|-----------|----------------------------|
| 1 | **A** event sourcing + node:sqlite | `remote-multiclient-event-sourcing` | now | `apps/server/src/persistence/*`, `message-store.ts`, `packages/wire/src/session.ts` |
| 2 | **B-renderer** WS client | `remote-multiclient-ws-client` | now | `apps/renderer/src/lib/rpc-client.ts` (+ new file), renderer `package.json` |
| 3 | **F** mobile scaffold | `remote-multiclient-mobile` | now | new `apps/mobile/**` (no overlap) |
| 4 | **G** SSH | `remote-multiclient-ssh` | now | new `packages/ssh/**`, `apps/desktop/src/ssh/**` |
| 5 | **D** relay | `remote-multiclient-relay` | now | new `infra/relay/**` (no overlap) |

A, B-renderer, F, G, D are **five genuinely parallel tracks**. C/E/H serialize after
(auth → tunnel → push). I (cloud) is deferred. Hand-off prompts and the
"don't-touch" boundaries that keep these from colliding are in
[`parallel-handoffs.md`](./parallel-handoffs.md).

---

## 6. PR breakdown

| PR | Title | Status |
|----|-------|--------|
| PR0 | wire contract (`MessageEnvelope`, `sinceSequence`, `providerKind`/`connect.*`) | ✅ landed |
| PR-B-server | WS transport + headless `bin.ts` | ✅ landed |
| PR-A1 | `node:sqlite` migration + `events` table + projector (route `MessagePersisted`) | todo |
| PR-A2 | cursor streaming (`streamMessages(sinceSequence)`, envelope publish, renderer cursor) | todo |
| PR-B-renderer | browser/renderer WS client + transport selection | todo |
| PR-G | SSH `packages/ssh` + desktop env + remote launch | todo |
| PR-C | auth/pairing (local bearer + QR, device DPoP, WorkOS) | todo |
| PR-F1 | mobile scaffold (Expo + WS wire client + LAN QR + read-only views) | todo |
| PR-F2 | mobile interact (send/approve/answer/interrupt; reconcile via `sinceSequence`) | todo |
| PR-D | relay deployable (`infra/relay` + link/connect endpoints) | todo |
| PR-E | managed tunnel (Cloudflare connector + relay mapping + mobile cloud connect) | todo |
| PR-H | push (`agent-activity` publish + APNs + Live Activities) | todo |
| PR-I | cloud environments provisioner (deferred) | deferred |

---

## 7. ADRs to author

Spin these into `specs/remote-multiclient/decisions/` as each workstream lands:
- **Event sourcing for chat persistence** (events in front of projections; tradeoff).
- **`node:sqlite` persistence driver** (ABI-split finding; D2).
- **WebSocket transport & headless boot** (extends ADR 0007).
- **Environment abstraction & cloud-hosted worktrees** (`providerKind`; provisioner deferred).
- **Cloud reach: relay + managed tunnel + WorkOS** (control plane only; DPoP).
- **SSH remote environments** (native-binary wrapper; tunnel lifecycle).

---

## 8. Risks

- **R1 Partial-streaming assistant rows** — drivers emit deltas as discrete full rows
  (`eventToContent`), so append-only holds today; forbid future in-place row mutation (use
  a `MessageSuperseded` event if needed). Audit `eventToContent` callers.
- **R2 `queued_messages` is lazy-DDL** (`ensureQueuedMessagesSchema`, outside the migrator)
  — keep queue as CRUD in v1; don't route it through events. Fold its DDL into a real migration.
- **R3 Multi-client write ordering** — concurrent appends hit the
  `(stream_kind, stream_id, stream_version)` unique index; `appendEvent` needs a bounded
  retry recomputing `MAX(stream_version)+1`.
- **R4 Backfill** — the events migration must synthesize one event per existing `messages`
  row in `(created_at, rowid)` order and stamp `sequence` on both, before any client connects.
- **R5 Append/projection atomicity** — both inside one transaction; **broadcast PubSub
  after commit** (never publish an event that may roll back); `sinceSequence` resume closes
  any crash-between-commit-and-publish gap.
- **R6 `MessageEnvelope` typed flag-day** — flipping `messages.stream` `success` ripples to
  the renderer consumer (single repo, ~1); grep before landing PR-A2.
- **R7 `node:sqlite` availability** — verify Electron 42's bundled Node exposes it (D2
  prerequisite); fallback documented.
- **R8 Relay attack surface** — short-lived DPoP tokens, WorkOS-gated, relay never sees
  chat data. Pen-test before exposing.

---

## 9. Verification

- **A:** unit-test `appendEvent` ordering + unique-violation retry; property test "replay
  from 0 reproduces the `messages` projection"; reconnect test (stream → drop → resubscribe
  `sinceSequence` → zero gaps/dupes). Run with the in-memory sqlite mode.
- **B:** boot `zuse serve`, point the renderer at `ws://127.0.0.1:<port>/rpc`, run a chat
  end-to-end; confirm the IPC path still works.
- **G:** `ssh -G` resolve a fixture host; launch on a real remote box, tunnel, drive a chat;
  kill tunnel → assert Scope teardown.
- **F:** Expo on LAN, QR-pair, view a live chat, send, approve a tool; airplane-mode →
  snapshot renders → reconnect reconciles.
- **D/E:** link an environment, fetch a connect token, reach the desktop through the tunnel
  from cellular; confirm the relay never proxies chat bytes.
- **H:** trigger an approval; assert APNs delivery + Live Activity update.
- Gate every PR on `turbo build lint check-types test`.

---

## 10. Progress log

- **2026-06-30 — PR0 (`9f46554`)**: wire contract. `MessageEnvelope`, optional
  `sinceSequence` on `messages.stream`, `ProviderKind`/`EnvironmentDescriptor`/`connect.*`
  in `packages/wire/src/connect.ts`, `EnvironmentId`. Behavior-neutral; whole-repo
  `check-types` passes.
- **2026-06-30 — PR-B server (`1a2db6f`)**: `apps/server/src/transports/ws.ts`
  (`wsServerProtocolLayer`) + headless `bin.ts` (`runHeadlessServer`). Live boot verified:
  the full layer graph + WS protocol construct and reach DB init. Surfaced the `node:sqlite`
  decision (D2) from the native-ABI failure.

---

## Appendix A — Core design (file-grounded)

Effect-style throughout (`Effect.gen`, `Stream`, `Layer`, `@effect/sql`). Anchors:
`message-store.ts` (`persistMessage`, `startSubscription`, `streamMessages`,
`broadcastMessage`); `apps/server/src/persistence/migrations.ts`;
`packages/wire/src/session.ts`; `apps/server/src/runtime.ts` (`MainLayerDeps`,
`ServerLayer`); `apps/renderer/src/lib/rpc-client.ts`; template
`apps/desktop/src/ipc/electron-server-protocol.ts`.

### A.1 Events table + projector
A new migration creates `events(sequence INTEGER PK AUTOINCREMENT, event_id UNIQUE,
stream_kind, stream_id, stream_version, type, occurred_at, actor, payload_json)` with a
`UNIQUE(stream_kind, stream_id, stream_version)` optimistic-lock index, plus
`ALTER TABLE messages ADD COLUMN sequence INTEGER` and a backfill (one synthetic
`MessagePersisted` per existing row, `(created_at, rowid)` order, stamping `sequence` on
both). `AUTOINCREMENT` gives the strictly-increasing global cursor that `created_at` never did.

`persistMessage` keeps its signature but routes through a transactional `appendEvent` that
inserts the event and **projects in the same transaction** via `projectEvent` (for
`MessagePersisted` this is today's `INSERT INTO messages` + `sessions.updated_at` +
`chats.last_message_at` writes). `appendEvent` computes `stream_version = MAX+1` and retries
on the unique-violation (R3). v1 routes **only** `MessagePersisted` through events; lifecycle
UPDATEs (status/cursor) may stay inline and migrate later. A boot-time `ProjectorCatchup`
layer (between the migrator and `MessageStore`) replays any events past the projection's
high-water mark, giving "rebuild from `sequence=0`" for free.

### A.2 Cursor streaming
`packages/wire/src/session.ts` already has `MessageEnvelope { sequence, message }` and an
optional `sinceSequence` on `MessagesStreamRpc` (PR0). PR-A2 flips `success: Message →
MessageEnvelope` and rewrites `streamMessages`: subscribe to the per-session
`PubSub<MessageEnvelope>` **before** `SELECT … WHERE sequence > since ORDER BY sequence`,
compute `lastReplayed` from the actually-replayed rows, then `Stream.concat(replay,
live.filter(e => e.sequence > lastReplayed))`. No `seen` Set, O(1) memory, gap-free resume.
`broadcastMessage` publishes the envelope **after commit**; the renderer records the highest
`sequence` per session and passes it back as `sinceSequence` on reconnect.

### A.3 WS transport (landed) + renderer client (todo)
Server (`transports/ws.ts`, landed): `RpcServer.layerProtocolSocketServer` ←
`NodeSocketServer.layerWebSocket({port,host})` ← `RpcSerialization.layerJson`, `orDie`'d
into `MainLayerDeps.serverProtocol`. `bin.ts` (landed) builds host deps without Electron and
boots via `NodeRuntime.runMain`. Renderer client (todo): `ws-client-protocol.ts` =
`RpcClient.layerProtocolSocket()` ← `Socket.layerWebSocket(url)` ←
`Socket.layerWebSocketConstructorGlobal` ← `RpcSerialization.layerJson`; `rpc-client.ts`
selects WS vs Electron by presence of `window.zuse`. Needs `@effect/platform` added to the
renderer package.
