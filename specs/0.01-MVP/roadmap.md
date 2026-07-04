# Roadmap

Estimates assume a single developer, ~6 productive hours/day, with a capable LLM pair-programmer. Effect-touching work has 30% headroom baked in.

## Phase 1 — Foundation ✅ (shipped)

- Folder sidebar + persistence
- Real PTY terminal
- Effect runtime + Layer architecture in both processes
- Typed RPC contracts in `packages/wire`

## Phase 2 — Agents (backend) ✅ (shipped)

- Provider availability detection (Claude / Codex CLIs + SDK keys)
- Keychain-backed credentials
- Claude SDK adapter + Codex SDK adapter
- Streaming `AgentEvent` union over RPC

The UI shipped in Phase 2 (Cmd+K launcher + single right-side timeline panel) is **deprecated** — see Phase 3 for the chat-first replacement. The backend (RPCs, drivers, credentials) is unchanged and reused.

## Phase 3 — Chat-first MVP (next, ~3–4 weeks)

The pivot. Replace the terminal-first shell with a three-pane chat IDE.

- SQLite persistence layer (`@effect/sql-sqlite-node` + `@effect/sql/Migrator`)
- Projects → sessions → messages schema; sessions are persisted + archivable
- Three-pane layout: projects/sessions sidebar, chat in center, files+terminal on the right
- Chat composer with model picker; markdown + code rendering
- Tool calls render inline as collapsible blocks
- Right pane: file tree (read-only) + terminal tab
- Drop the Cmd+K launcher and the single-session right panel; drop the git history pane

→ See [phases/03-chat-mvp.md](phases/03-chat-mvp.md)

## Phase 4 — Permissions & quality (~2 weeks)

Make the agent trustworthy enough to leave running.

- Permission prompts UI (file write / shell command / network) — replace Phase 2's auto-deny
- Per-session "always allow X" memory
- Resume an interrupted session after restart
- Inline diff rendering for `edit_file` tool calls
- NDJSON transcript export per session

→ See [phases/04-permissions.md](phases/04-permissions.md)

## Phase 5 — Polish & distribution (~3 weeks)

- Session search across projects
- Bulk archive / delete
- Themes + keybindings
- macOS code signing & notarization
- Auto-update via electron-updater
- Linux + Windows packaging

→ See [phases/05-polish.md](phases/05-polish.md)

## Total

| Milestone | Calendar |
|---|---|
| Backend complete (Phases 1–2) | shipped |
| Chat MVP private alpha (Phase 3) | ~4 weeks from now |
| Trust release (Phase 4) | ~6 weeks from now |
| 1.0 (Phases 1–5) | ~10 weeks from now |

## Beyond 1.0

ADR 0007's transport-agnostic split keeps these costs bounded — each becomes a focused PR, not a redesign.

| Milestone | What changes |
|---|---|
| Remote desktop access | `apps/server/src/bin.ts` becomes a real WS server boot; renderer's transport seam picks WS when running outside Electron. |
| CLI client | New `apps/cli/` consuming `@zuse/wire` over the WS transport. |
| Multi-window | Multiple Electron renderers connected to one backend — backend already supports it. |
| Mobile client | Native or web mobile app speaking WS to a desktop's server over LAN/tunnel. |

See [ADR 0007](decisions/0007-server-as-code-only-app.md) for the rules that keep these costs bounded.
See [ADR 0008](decisions/0008-sqlite-persistence.md) for the persistence story underpinning Phase 3.
