# Cloud Agent Platform — machines, autonomy, evidence & merge

Status: Roadmap (phases start as their own workstreams)
Started: 2026-07-15

Make Zuse a **cloud agent platform**: dev machines that agents set up once and
fork in seconds, plans drafted and critiqued by different models, harness-run
parallel builds, verification you clear by watching a video on your phone, and
a merge queue that lands overnight work — so human time stops being the
bottleneck of the software lifecycle.

This roadmap spans and sequences two existing initiatives rather than replacing
them:

- [`specs/remote-multiclient/`](../remote-multiclient/README.md) — the
  **infrastructure spine** (headless server, event sourcing, relay, mobile,
  SSH). Phases 1–3 here close its open workstreams (PR-E, PR-H, PR-I).
- [`specs/self-orchestration/`](../self-orchestration/README.md) — the
  **autonomy spine** (control-plane tools, loop engine, verification, safety).
  Phases 4–7 here sequence its Phases 2–4; its feature docs and ADRs remain the
  specs of record.

House structure applies: `decisions/` and `features/` are added per-phase as
phases start (nothing is stubbed up front). New ADRs continue the global
numbering (next: 0033).

---

## 1. Framing: six bottlenecks of human time

We benchmarked Zuse against the cloud-agent platform vision — the question
"where does human engineering time still go once models can run long on their
own?" decomposes into six bottlenecks:

1. **The machine** — real apps need many services running; agents that can't
   run the app chain the human to localhost. Fix: cloud dev boxes that agents
   set up on day one, snapshotted **with live processes**, forked per session.
2. **Planning** — the largest share of engineer attention. Fix: a planner model
   drafts, a *different* reviewer model critiques, and the human approves a
   **plan of plans** at high altitude.
3. **Orchestration** — landing many small tasks into one. Fix: the harness
   fans sub-plans out to parallel workers and runs judge/review/simplify passes
   itself, not as user-invoked commands.
4. **Testing** — if you still pull branches to localhost to test, cloud agents
   are useless. Fix: the agent boots the app and drives it end-to-end in a
   browser; the human clears testing by watching recorded evidence; every
   machine gets a hosted URL colleagues can open.
5. **Review** — an unattended run produces an 8000-line diff nobody wants to
   read. Fix: a native reviewer that makes big diffs consumable from a phone.
6. **The merge** — parallel overnight sessions collide. Fix: a merge queue
   with agent conflict resolution, re-verified before landing.

Zuse already owns the hardest substrate: a headless server with zero Electron
imports, event-sourced persistence with gap-free reconnect, SSH remote
execution, a **deployed** relay control plane, a mobile client that can approve
plans and permissions, shipped orchestration tools, native plan modes, and a
CDP agent browser. This roadmap is therefore an **activation-and-extension
sequence**, not a rewrite: dormant code first, then the one missing pillar
(cloud machines), then the autonomy → testing → review → merge layers.

---

## 2. Locked decisions

### D1 — MicroVM provider with native memory-snapshot/fork
Cloud machines run on a **Firecracker-class microVM provider** (evaluate the
Morph / e2b / Fly Machines class) behind the existing
`providerKind: "cloud"` seam ([`packages/contracts/src/connect.ts`](../../packages/contracts/src/connect.ts)).

- **Why:** the keystone UX — "snapshot the machine with live processes, fork
  new sessions ready-to-go in seconds" — is native to microVM memory
  snapshotting. Raw VMs only offer volume snapshots (processes die, boots take
  minutes); recreating live-state fork there means CRIU or image-baking
  pipelines — months of infra work for a small team.
- **Provider is swappable:** the provisioner talks to a provider adapter; the
  seam in contracts means no code path above the transport changes if we swap.
- **Raw VMs later, only on demand:** nested-virt workloads (mobile emulators)
  would justify a second provider tier behind the same seam. BYO boxes are
  already served by the SSH path (`packages/ssh`).

### D2 — Additive evolution over the existing spines
Remote-multiclient's D3 already holds: *a cloud worktree is not a new code
path*. The same `zuse serve` binary ([`apps/server/src/bin.ts`](../../apps/server/src/bin.ts))
runs on desktop, SSH box, and cloud container; the relay keys everything by
`environmentId`. Every phase below extends landed code and cites it.

### D3 — Evidence over trust
Autonomy features never ship ahead of their verification counterpart: fan-out
(Phase 5) precedes unattended fleets (Phase 7) only via the ship lane
(Phase 6). This is self-orchestration's "loops you can trust" bet, kept intact.

---

## 3. Phases

Each phase is independently shippable and useful. Scope: S/M/L/XL.

| # | Phase | Attacks | Scope | Depends on |
|---|-------|---------|-------|------------|
| 1 | Reachable Anywhere | B1, B4 partial | S–M | — |
| 2 | Cloud Machines v1 | B1 core | L | 1 |
| 3 | Instant Machines | B1 complete | XL | 2 |
| 4 | Plans You Can Trust | B2 | M | — (parallel track) |
| 5 | The Harness Runs the Loop | B3 | L | 4 |
| 6 | Proof, Not Promises | B4 | L | 5 (URLs need 1) |
| 7 | Overnight Backlog + Phone Review | B1 fleet, B5 | L–XL | 3, 5, 6 |
| 8 | Merge Without Mornings | B6 | M–L | 7 |

### Phase 1 — Reachable Anywhere (activate what's built)

**Ships:** any environment — desktop or SSH box — reachable off-LAN at a stable
`wss://` hosted URL; the phone works from anywhere; a push notification fires
when an agent needs approval, finishes, or asks a question.

- Activate the managed Cloudflare named tunnel per (account, environment):
  [`infra/relay/src/managed-tunnel.ts`](../../infra/relay/src/managed-tunnel.ts) +
  [`apps/server/src/relay/managed-tunnel-runtime.ts`](../../apps/server/src/relay/managed-tunnel-runtime.ts).
  Remaining work is configuration (`MANAGED_TUNNEL_*`, `CF_API_TOKEN`) plus
  `cloudflared` provisioning — **PR-E** in remote-multiclient.
- Wire APNs into the push scaffolding: [`infra/relay/src/push.ts`](../../infra/relay/src/push.ts)
  + `apps/mobile` notifications — **PR-H**. Trigger points already exist as
  domain events (permission requests, plan approvals, session idle).

**Why first:** near-zero design risk; exercises the relay under real load
before cloud machines multiply environment counts; makes the mobile app a
daily driver — every later "supervise from your phone" story depends on it.

### Phase 2 — Cloud Machines v1 (the missing pillar)

**Ships:** "New cloud machine" from desktop or phone. A microVM boots with a
persistent volume, `zuse serve` self-registers with the relay, gets a tunnel
URL, and appears under "Your computers." Sessions, worktrees, and the agent
browser work exactly as on an SSH box today. Machines idle-stop and resume
with state on the volume.

- Implement `providerKind: "cloud"` — **Workstream I / PR-I**, already designed
  in remote-multiclient (D3: cloud is not a new code path).
- Provisioner as a relay capability: extend `infra/relay/` (environment
  registry, self-registration flow) with machine lifecycle endpoints; the
  microVM provider sits behind an adapter (D1).
- Bootstrap reuses the SSH launch pattern (`packages/ssh`) and the existing
  `ZUSE_PORT/HOST/ADVERTISED_HOST` env surface in `bin.ts`.
- Repo checkout + auth on the box via the existing three-tier credential model
  (per-environment `zenv_` credential, Ed25519 link proof).
- **Embedded spike (gates the provider decision):** memory-snapshot/fork a
  machine running `zuse serve` + a dev server + a database *before* the
  provider is locked. See risk A1.

### Phase 3 — Instant Machines (day-one setup + snapshot/fork)

**Ships:** point Zuse at one or more repos; a **setup swarm** performs day-one
setup — secrets (asked for, never guessed), auth, seed data, multi-repo
layout, services running — verified by driving the live app with the agent
browser. The result is snapshotted **with live processes**; new sessions fork
from the snapshot in seconds. This is the moment "every ticket gets its own
machine" becomes physically cheap.

- **Environment recipes:** a durable artifact (checked-in or relay-stored)
  describing setup steps, so machines are reproducible, not artisanal.
- The setup swarm is ordinary Zuse orchestration —
  [`packages/agents/src/drivers/orchestration-tools.ts`](../../packages/agents/src/drivers/orchestration-tools.ts)
  (`create_thread`, `send_to_thread`) running *on the box*, verified with
  [`packages/agents/src/drivers/browser-tools.ts`](../../packages/agents/src/drivers/browser-tools.ts).
- Snapshot/fork surfaced in the relay as a first-class object: snapshot
  lineage, fork-from-snapshot as the fast path of "New cloud machine."
- **New ADR — fork identity:** a forked server must re-key (new environment
  ID, new `zenv_` credential, new tunnel) while the append-only SQLite event
  log diverges cleanly per fork.
- Worktree env-file copy + port allocation in `packages/git` already handles
  concurrent checkouts; reuse as-is inside each fork.

### Phase 4 — Plans You Can Trust (planner + reviewer)

**Ships:** planning becomes a two-model conversation: a planner drafts, a
*different* reviewer model critiques, and the user sees a **plan of plans** —
one high-level plan decomposing into ~5–9 sub-plans — approved at the top
level, not line-by-line. Plans are durable artifacts, not chat scrollback.

- Plan artifacts per **ADR 0030**: plans as event-sourced entities in
  `packages/domain`, rendered natively on desktop and mobile.
- Reviewer pass extends the existing plan modes — native probes and the
  emulated fallback in
  [`packages/agents/src/drivers/planMode.ts`](../../packages/agents/src/drivers/planMode.ts) —
  with a second model critiquing before the plan reaches the user (only the
  narrow "reviewer is a different model" slice of cross-provider ADR 0012).
- Decomposition reuses plan handoff
  ([`apps/renderer/src/lib/context-handoff.ts`](../../apps/renderer/src/lib/context-handoff.ts),
  `.context` files): each sub-plan is a handoff-ready context — exactly what
  Phase 5 fans out.
- Frontend look-before-code, slim v1: the planner produces static HTML mockups
  rendered in the existing shared webview for approval.
- **Cloud-independent by design** — a parallel track that keeps shipping value
  on desktop/SSH if Phases 2–3 stall on provider evaluation.

### Phase 5 — The Harness Runs the Loop (orchestration)

**Ships:** approving a plan-of-plans causes the main agent to fan out parallel
worker threads (~5–9), each building one sub-plan in its own worktree, with
judge/review/simplify passes built into the harness rather than user-invoked
commands. A Loops panel shows the tree of work; a kill switch stops
everything. `autonomous` finally means autonomous.

- Loop engine per **ADR 0025/0028** (fiber scheduler, loop state file,
  heartbeat/goal/wake-on-event) —
  [self-orchestration Phase 2](../self-orchestration/features/loop-engine.md).
- Kill switch (**ADR 0026**) — the explicit blocker on un-aliasing
  `autonomous` from `approval-gated` in the autonomy gating.
- Fan-out uses the shipped control-plane tools (`create_thread` already
  creates worktree+branch+chat+session); judge/review roles are real threads
  (**ADR 0024**), with SDK sub-agents (existing `StartSessionInput.agents`
  forwarding + `SubagentSummary` rendering) as cheap intra-thread critics.
- The per-session message queue (flush on idle) gives the orchestrator safe
  steering of busy workers.

### Phase 6 — Proof, Not Promises (testing + evidence)

**Ships:** every completed sub-plan passes the **ship lane**: isolated
worktree → adversarial review → the agent boots the app and drives it
end-to-end in the browser → **recorded video evidence**. The user clears
testing by watching a ~90-second video on their phone. Every machine's running
app gets a hosted URL a colleague can open; the box's browser view supports
live commenting.

- Verification pipeline per **ADR 0029** with the objective gate (**ADR
  0027**) as the pass/fail authority —
  [self-orchestration](../self-orchestration/features/verification-pipeline.md).
- E2E driving reuses the CDP browser stack
  (`browser-tools.ts`/`browser-mcp-tools.ts`); the CDP bridge lives in the
  desktop today (`apps/desktop/src/main.ts`), so this phase adds a
  **headless-Chromium bridge in `apps/server`** for cloud boxes.
- **Net-new: CDP screencast → video artifact** per verification run, streamed
  to mobile; plus live browser-view streaming for on-box commenting.
- **Virtual-display lane (Xvfb):** Electron apps under test run on headless
  boxes — Electron speaks CDP natively (`--remote-debugging-port`), so the
  same browser tools drive it. This makes Zuse able to test *itself* in the
  cloud.
- Hosted app URLs: extend the Phase 1 tunnel from the `wss://` control channel
  to worktree-allocated HTTP ports (the `packages/git` port allocator already
  knows which ports each worktree owns).
- `git.fixFailingChecks` (statusCheckRollup → agent artifact) plugs in as the
  CI-side gate input.

### Phase 7 — Overnight Backlog + Phone Review

The integration milestone — the first phase that *composes* rather than
builds.

**Ships:** connect a backlog (GitHub issues are already readable via
`packages/git`; Linear/Jira via **ADR 0032** connector passthrough). Overnight,
every selected ticket forks a machine from the snapshot and runs
plan → build → verify unattended, cost-capped. Morning delivers a queue of
verified results on the phone: a **native reviewer** that makes an 8000-line
diff consumable — prioritized hunks, plain-language change narration, risk
callouts, inline evidence videos — with approve/redirect actions on the
mobile approval surfaces that already exist.

- Nightly runner = goal loops (Phase 5) × fork-from-snapshot (Phase 3) ×
  relay-side scheduling in `infra/relay/`.
- Native review is primarily a renderer + `apps/mobile` feature over a new
  diff-summarization projection in `packages/domain`, emitted by the verify
  stage; push (Phase 1) delivers "3 tickets ready for review."
- Spend caps and per-lineage budgets per
  [autonomy-and-safety](../self-orchestration/features/autonomy-and-safety.md).

### Phase 8 — Merge Without Mornings (merge queue)

**Ships:** a merge queue for agent branches: sequenced landing, auto-rebase,
and an agent conflict-resolution pass — itself re-verified through the Phase 6
ship lane before landing. The human approves queue order and any conflict
resolution; the queue does the mechanical work.

- Extends `packages/git` (PR merge / ready / GitHub auto-merge toggle already
  exist) with queue state as event-sourced entities in `packages/domain`.
- Conflict resolution is a specialized thread spawned via the existing
  orchestration tools.
- v1 is serialized landing + rebase-and-reverify; batch/optimistic queueing
  later. **New ADR — merge-queue semantics.**

---

## 4. Riskiest assumptions — validate early

- **A1 — Live-process snapshot/fork is production-real** (Phase 3 keystone).
  Does the provider's memory fork survive a running dev server with file
  watchers, a database, and `zuse serve`'s open SQLite handles — and can fork
  identity (event-log divergence, re-registration, re-keyed `zenv_`) be made
  clean? **Validate in the Phase 2 spike, before the provider is locked.**
  Fallback: volume-snapshot + fast cold boot — downgrades Phase 3's promise
  from seconds to a minute-plus, which changes the fleet economics.
- **A2 — Users approve at plan-of-plans altitude.** The overnight economy
  assumes high-level approval is trusted enough that people don't re-litigate
  sub-plans. Validate cheaply in Phase 4 by dogfooding the planner+reviewer
  harness on Zuse's own backlog and measuring sub-plan drill-in/edit rate.
- **A3 — Unattended runs clear the objective gate at useful cost.** If
  overnight slop or token spend is too high, Phase 7 collapses into supervised
  parallelism rather than a fleet. Validate at the end of Phase 5/6 with a
  small nightly loop (3–5 tickets) on Zuse's own repo before building
  connectors and the fleet scheduler. Secondary: one named tunnel per
  environment must hold up in count and interactive-WS latency as machines
  multiply — watch from Phase 2.

---

## 5. Deliberately out of scope

- **Prod access post-merge** (Postgres/K8s/feature-flag operation): highest
  blast radius, weakest trust foundation today. Revisit only after the merge
  queue has months of history.
- **Native iOS/Android emulators in the cloud:** need nested virt → the
  raw-VM provider tier (D1). Revisit on user demand.
- **Full OS-level computer use** (arbitrary native apps via screenshot + input
  injection): a follow-on extension of Phase 6's virtual-display lane, not
  core scope. CDP-addressable apps — including Electron — are covered.
- **Full design tooling for frontend:** Phase 4 ships mockup-before-code only;
  a real design surface is its own product.
- **Browser-based full client:** renderer-over-WS groundwork exists
  (PR-B-renderer), but desktop + mobile cover supervision; a web client is
  opportunistic, not on the critical path.
- **Cross-provider sub-agents as a general framework (ADR 0012):** only the
  "reviewer is a different model" slice is needed (Phase 4).

---

## 6. Specs to author (as phases start)

Features (`features/`): `cloud-provisioner.md` (Phase 2), `snapshot-fork.md` +
`environment-recipes.md` (Phase 3), `evidence-capture.md` (Phase 6),
`native-review.md` + `backlog-runner.md` (Phase 7), `merge-queue.md`
(Phase 8). Phases 4–6 otherwise build on the existing self-orchestration
feature docs.

Decisions (`decisions/`, continuing global numbering from 0033): fork
identity (Phase 3), video artifact storage (Phase 6), merge-queue semantics
(Phase 8).
