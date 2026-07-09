# Changelog

All notable changes to Zuse Alpha will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.1]

### Changed
- Fix skipped chat lineage migration

## [0.12.0]

### Added
- Self-orchestrating agents: Phase 1 control plane + spec (#250)
- [codex] Add shared HTTP MCP gateway (#292)
- Add Grok 4.5 model picker support (#294)

### Changed
- Mobile UI overhaul: naming, new chat, session, stream, permission, inbox (#295)
- [codex] Remove manual sub-agent settings (#297)
- [codex] Improve model picker defaults (#299)

### Fixed
- [codex] Fix Grok native permission handling (#291)
- [codex] Fix WorkOS auth persistence (#296)
- [codex] Fix auth client startup retry (#298)

## [0.11.0]

### Added
- [codex] Add browser visual annotations (#277)
- [codex] Add remote mobile push notifications (#272)
- [codex] Add advertised endpoint model (#270)
- Add managed relay tunnel support (#266)
- Mobile: interactive chat — question cards, permission approvals, offline outbox, markdown (#265)
- Add OpenCode provider management: connect providers, custom endpoints, visibility (#260)
- Account-based laptop → phone connection (relay + WorkOS + DPoP) (#262)
- [codex] add zuse repository settings and bundled skill (#258)
- [codex] Implement remote multi-client foundations (#259)
- [codex] Add create-from source picker (#257)
- [codex] add macbook notch notification tray (#249)
- Auto-update: background download, restart toast, quit guard (#256)

### Changed
- Refine mobile composer controls (#285)
- [codex] Polish mobile chat UI (#282)
- [codex] Polish PR checks and feedback UI (#284)
- [codex] Redesign mobile UX (#280)
- Harden mobile connection runtime (#273)
- [codex] Update mobile app identity (#274)
- Improve chat timeline scrolling (#269)
- [codex] Align chat footer controls (#267)
- iOS native polish: glass surfaces, animated presence dots, haptics (#264)
- Mobile: Expo 54→57 upgrade + iOS-native design pass (@expo/ui) (#263)
- [codex] Store editable settings in JSON (#248)
- Improve chat auto-naming with real-time sidebar updates (#247)

### Fixed
- Fix mobile relay and queued sends (#287)
- Fix live chat sync (#286)
- Fix mobile relay DPoP auth (#279)
- [codex] Fix provider update state bleed (#278)
- [codex] fix WorkOS refresh token persistence (#275)
- Fix chat timeline live scrolling (#271)
- [codex] Fix project accordion toggle (#268)
- [codex] Fix chat autoscroll performance (#261)

## [0.10.3]

### Changed
- Finish WorkOS sign-in on a proper "Signed in — you can close this tab" page instead of leaving the browser hanging on a dead `zuse://` URL, and drop the OS "Open in Zuse Alpha?" prompt. Packaged builds now use the localhost loopback redirect (like dev); the `zuse://` scheme handler stays registered as a fallback.

## [0.10.2]

### Fixed
- Actually inline the public WorkOS client id into release builds: Turborepo's strict env mode was stripping `WORKOS_CLIENT_ID` before `tsdown` ran, so packaged builds shipped an empty id and sign-in reported "WorkOS is not configured". Declared the var in `turbo.json` so it reaches the build. Supersedes 0.10.1, which still shipped empty.

## [0.10.1]

### Fixed
- Supply the public WorkOS client id at release build time so sign-in works in packaged builds instead of surfacing "WorkOS is not configured".

### Changed
- Fork chat + plan/context handoff (#252)
- Route pasted text & dropped files into .context/files (#246)

## [0.10.0]

### Changed
- Fix flickering plan-approval banner (#244)
- Fix mermaid error bomb bar + jittery send animation (#243)
- [codex] add provider contract test fixtures (#242)
- [codex] Improve bug report diagnostics flow (#241)
- [codex] Disable runtime code indexing (#240)
- Add LAN auth pairing for WS server (#238)
- [codex] add renderer websocket rpc client (#239)
- [codex] continue external agent threads (#237)
- [codex] add agent browser v2 (#236)
- [codex] Add Expo mobile read-only client (#235)
- [codex] Add renderer toast notifications (#234)
- [codex] Add markdown and HTML preview tab (#233)
- [codex] add event-sourced persistence and cursor streaming (#232)
- Remote/multi-client foundation: wire contract + WS transport + spec (#218)
- [codex] add light and system appearance support (#229)

## [0.9.0]

### Changed
- [codex] Fix dirty worktree removal feedback (#222)
- [codex] Remove competitor mentions (#227)
- [codex] Show approve bar for emulated plan mode (#226)
- Clean up stale memoize branding (#225)
- [codex] fix codex context status accounting (#224)
- [codex] Fix stale wire package imports (#223)
- [codex] Polish streaming chat motion (#221)
- feat(auth): WorkOS AuthKit login (PKCE, keychain, optional) (#219)
- [codex] Add Claude Fable 5 support (#220)
- Add diagnostics bundle export (#206)
- [codex] Refine renderer color palette (#216)
- [codex] Float chat scroll controls (#217)
- [codex] clean model picker (#215)
- Fix messages not appearing until chat re-open (hydrate race) (#210)

## [0.8.3]

### Fixed
- Zuse data migration now checks the actual project count before deciding whether the new `Zuse Alpha` database is empty. This recovers users who already launched Zuse once and have a migrated schema with no projects.

## [0.8.2]

### Fixed
- Zuse now migrates data from legacy sibling Application Support folders such as `memoize Alpha` and `memoize` when the new `Zuse Alpha` database is still empty. The empty Zuse database is backed up before the legacy database is copied forward.

## [0.8.1]

### Fixed
- Restored the macOS bundle identifier to `app.memoize.desktop` so existing memoize Alpha installs can accept Zuse Alpha updates in place through Squirrel.Mac. The app name and GitHub release feed stay Zuse, but the updater identity remains stable for compatibility.
- Legacy memoize keychain credentials are now promoted into the Zuse keychain namespace after first successful fallback read.

## [0.8.0]

### Added
- Live file tree updates now track disk changes and support create/delete flows with confirmation dialogs. (#204)
- New worktrees can auto-symlink nested environment files for monorepos and Cloudflare projects. (#201)

### Changed
- memoize Alpha is now Zuse Alpha. The app now uses the Zuse bundle identifier (`app.zuse.desktop`), GitHub release feed, package names, worktree paths, protocol links, keychain service, and SQLite paths. Existing data and legacy `memoize://` links remain readable where possible, but this is a full technical identity move to Zuse rather than an updater-compatible in-place rename. (#207)
- Removed remaining legacy source references from user-facing copy and project metadata. (#198)
- Loading states now use animated gradient shimmer polish. (#200)

### Fixed
- Force-archiving can remove a chat even when its worktree is dirty. (#197)
- Plan feedback routing now reaches the correct agent turn. (#205)
- Claude interruptions now render as an interrupted badge instead of a hard error. (#202)

## [0.7.1]

### Changed
- [codex] Fix Claude result error classification (#195)
- [codex] Fix website changelog publishing (#194)
- [codex] Optimize Pokédex page (#193)
- Terminal: fix pane overflow, GPU rendering, thin cursor (#192)
- Add app-wide motion system to the renderer (#188)
- Keyboard navigation: tabs, chats, panels, panes + Cmd+K chat switcher (#191)
- Isolate terminals & dock tabs per chat, keep shells running across switches (#190)
- Cap turn-summary file chips with collapsible +N more toggle (#189)
- Render sub-agent summary as markdown (#187)
- Move plan Approve/Cancel into a pinned bar above the composer (#186)

## [0.7.0]

### Changed
- Surface supervised-mode permission prompts in sidebar and tabs (#184)
- Render inline chat Edit diffs with @pierre/diffs library (#183)
- Auto-scroll on send and cap tool box height (#182)
- Fix false "Requires Claude Pro" gate for paid Claude logins (#179)
- Add goal mode support for the Grok provider (#181)
- Surface Claude auth failures as an in-app "Sign in to Claude" card (#180)
- Compact composer trays into a unified pill stack (#178)
- Cap collapsed tool row width (#176)
- Unify composer + bubble pill styling (#175)
- Auto-publish releases instead of drafts (#174)

## [0.6.1]

### Changed
- [codex] Fix queue resume after stop (#172)
- Base new worktrees on origin's default branch, not stale local HEAD (#171)
- Persist composer drafts (#168)
- Dock-style hover-reveal for the left sidebar (#170)

## [0.6.0]

### Changed
- Add tokenmaxer onboarding and usage fixes (#166)
- Add multi-source token usage dashboard (#164)
- Drive the agent browser with real input + a rendered cursor (#165)
- [codex] Show active task in project plan header (#160)
- Make release skill available to Claude and Codex (#163)

## [0.5.0]

### Added
- Worktree setup now streams live progress in the app, with a dedicated setup card and the Run action moved into the top bar for faster project startup. (#159)
- The right sidebar can be customized as a panel dock, making terminal, browser, files, and supporting tools easier to arrange per workflow. (#156)
- Codex goal mode is supported in chat sessions, giving agents a persistent objective and visible goal state during longer work. (#151)
- Context window and usage-limit status popovers expose model usage and limit state without digging through raw provider output. (#154)
- The website now has a direct download route for the latest signed macOS build. (#150)
- Codex feature controls are gated by CLI capability, with fast mode surfaced only when the installed CLI can support it. (#158)

### Changed
- Worktree creation is faster, Pokemon chips are cleaner, and rare unlocks now appear as toasts instead of taking over the chip UI. (#157)
- Code annotation composition and navigation are more polished, including clearer tray behavior and source reveal handling. (#153)
- Loading states now use a simpler solid spinner treatment instead of the previous dotted loader set. (#155)

### Fixed
- Claude sessions now initialize with the correct worktree current working directory, so prompts run in the intended workspace. (#161)
- Project Plan tray parsing supports newer TaskCreate and TaskUpdate tool event shapes. (#152)

## [0.4.0]

### Added
- Worktree setup scripts can now run per project/worktree, giving agents a first-class way to prepare dependencies and local environment before starting work. (#126)
- Mermaid diagrams render directly in markdown responses. (#128)
- Chat titles and worktree branches can be generated from the first user message, making new agent runs easier to scan and easier to identify in git. (#129)
- GPT-5.5 Codex is available in the Codex model picker. (#130)
- Chat rows now include state icons for faster scanning across idle, running, and attention-needed sessions. (#132)
- Agent completion sounds and deeper permission diagnostics make long-running work and blocked permission flows easier to notice and debug. (#133)
- Agent message queue persistence keeps queued follow-up messages across renderer/server restarts and improves queue handling for multi-message agent workflows. (#136)
- Chats now track read/unread state, with Next unread navigation for moving through updated sessions quickly. (#137)
- Pokémon worktree Pokédex gives the new Pokémon-named worktree system a dedicated browsing surface. (#140)
- Code annotations composer adds a richer composer path for referencing and annotating source code while prompting agents. (#141)
- Public Memoize landing site. (#142)

### Changed
- Grok auth noise is hidden more aggressively and agent activity is grouped for a cleaner timeline. (#127)
- Claude Ultracode UI is refined so the new model/provider controls fit the rest of the provider experience. (#131)
- Loaders were standardized around a smoother circle/comet treatment. (#135)
- Renderer iconography moved from Lucide to Hugeicons Pro, with real provider logos replacing generic marks. (#138)
- Changes tab cleanup improves file selection, revert flows, conflict handling, and sidebar diff stats. (#139)
- Renderer surfaces were cleaned up across the app for a tighter, more consistent desktop UI. (#143)
- Renderer icons were polished after the Hugeicons migration. (#144)
- Settings UI was cleaned up for a clearer, denser configuration experience. (#145)

### Fixed
- Permission prompts are now delivered reliably mid-turn, preventing stuck or missed approval flows while an agent is running. (#134)

## [0.3.3]

### Added
- Claude provider updates: Opus 4.8 and Ultracode model options, plus plan mode now always routes edits through prompts. (#111)
- ACP agents (Grok, Gemini, Cursor) can execute real terminal/output commands instead of rendering terminal requests as inert tool calls. (#112)
- In-app agent browser control drives the existing Electron webview, so agents can navigate and inspect pages without opening a separate browser surface. (#117)
- Top bar can now show live CI state and offers direct merge / auto-merge actions. (#113)
- Provider cards surface available CLI updates for supported providers. (#114)
- Claude fast mode toggle for faster lower-latency Claude sessions. (#119)
- Archive cleanup scripts and related repository cleanup controls. (#120)
- Repository branch toolbar for faster branch/context switching. (#124)

### Changed
- Markdown rendering is more polished and consistent in chat output. (#121)
- Grok access detection now accepts X Premium+ / SuperGrok entitlements. (#122)

### Fixed
- Grok sessions no longer abort mid-turn when the ACP child surfaces transient `AuthorizationRequired` noise inside `session/update` error frames while the turn is still completing normally. The shared ACP translator now filters that frame on the grok channel so in-flight prompts aren't rejected and the session doesn't flip to idle prematurely.
- New chats run inside their selected worktree and create branches from a fresh `origin` base. (#115)
- Codex tool translation handles the current tool event shape correctly. (#123)

## [0.3.2]

### Added
- Three-way "add project" menu (Open project / Open GitHub project / Quick start) with clone and create-project dialogs — templates Empty / Next.js / Turborepo and an optional private GitHub repo on create (gh-authed). (#104)
- Project Plan tray docked above the composer: surfaces the agent's TodoWrite task list as a collapsible panel with an "X of Y Done" count and per-item status icons, reading the list from either the Claude (`tool_use` input) or Grok (`tool_result` output) shape. (#107)

### Changed
- Git-not-a-repo handling: a new `git.init` RPC and a shared "Initialize Git repository" CTA replace the raw error payload across the Changes, PR, and Diff tabs; the failure is classified inside the Effect (typed `GitNotARepoError`) so the CTA fires reliably, and the Diff view re-fetches immediately after an in-place init. (#104, #105)
- A lone terminal now spans the full pane width; the terminal-list sidebar appears only once there are 2+ shells, with a floating hover-revealed `+` to add more. (#104)
- Grok native tool results (`list_dir` / `grep` / `read` / `edit`) now render as clean rows — directory tree, grouped grep matches, file contents, and real diffs — instead of raw JSON envelopes or byte-array char codes. (#106)

### Fixed
- Auto-update on macOS was stranded: `electron-updater` (Squirrel.Mac) needs a ZIP of the `.app`, but releases only shipped a DMG. Each release now ships a `zip/universal` target alongside the DMG, so auto-update works from 0.3.2 onward. (#108)
- External (http/https) links now open in the system browser instead of hijacking the app window or spawning an in-app Chromium window; the Vite dev origin is whitelisted so HMR is unaffected. (#108)
- Create-project dialog no longer crashes — the base-ui Checkbox hook error is gone, replaced with a native checkbox. (#105)
- Files outside the project folder can be opened, edited, and saved via dedicated external-file RPCs, with clickable out-of-workspace file chips. (#105)

## [0.3.1]

### Added
- Multi-terminal sub-sidebar in the right pane: the Terminal tab now lists every terminal for the workspace with a `+` to spawn more, click-to-switch, and hover-X to close. All instances stay mounted so xterm scrollback and PTY connections survive switches, and closing the last terminal re-seeds a fresh one. (#95)
- In-app Browser tab driven by an Electron `<webview>` with back/forward/refresh and a URL bar, sandboxed in its own process. Bare hosts default to `https://`, except `localhost`/`127.0.0.1` which default to `http://` for dev servers. (#95)
- Standalone MCP server now wires up the full hybrid `code_search` pipeline (symbol + BM25 + vector + RRF + rerank) instead of the symbol-only stub, shared with `IndexService` via a single `search()` module. `index_status` reports populated blob/chunk/symbol/ref counts, and a new `reindex` tool exposes a full pass to agents. (#97)
- ACP file-system handlers for `create_directory`, `delete_file`, and `move_file`, plus method aliases (`writeTextFile`, `mkdir`, `unlink`, `rename`, …) and flexible write payloads (`dataBase64` / `content` / `text` / `data`). (#98)

### Changed
- Creating a new chat session no longer freezes the UI for ~60s. The `+` on the tab strip now opens an instant tab backed by a loading panel while the provider CLI boots on a background daemon; sessions start in a `booting` state and flip to `idle`/`running` (or `error`) once the handshake completes. (#99)
- Single source of truth for sensitive-path detection and FS-operation policy (read / write / create / delete / move), honoring runtime and permission modes, with every ACP mutation routed through it. (#98)

### Fixed
- Grok agent reliability: a 4s startup grace window swallows transient `Auth(AuthorizationRequired)` stderr during cached-token refresh so the first message no longer shows a red error card; the worker now transparently respawns on death instead of asking you to close the chat; and MCP-style tool output is flattened so `read_file` results render as code instead of raw JSON. (#101)
- Cursor driver: `cursor-agent` is prewarmed at boot (time-to-first-token 18s → 5.8s), the model picker uses ACP-valid slugs with aliases for old persisted settings, `session/load` resumes sessions (falling back to `session/new`), and tool-call frames are logged to `~/.cache/memoize/cursor.log` with arguments and tool names preserved across updates. (#96)
- UX cluster: external links now open in the system browser instead of inside the app, switching a chat's worktree restarts member sessions in the new cwd, out-of-workspace file chips are flagged non-clickable with a tooltip, image attachments open inline in a tab, and Cmd+W closes the active file tab before falling through to archiving the chat tab. (#102)
- Auto-acknowledge `ask_user_question` and `_x.ai` / `_google` namespaced ACP methods in the grok, gemini, and cursor drivers so interactive prompts no longer hang the agent turn. (#98)

## [0.3.0]

### Changed
- **App renamed to "memoize Alpha"** to signal that this build is pre-1.0 and may contain bugs. The bundle identifier (`app.memoize.desktop`) is unchanged, so existing installs auto-update to the renamed app in place. Dock title, About panel, and macOS app menu now read "memoize Alpha"; the in-app brand and CLI / URL scheme stay as `memoize`.

### Added
- Full-pane diff view in the file viewer with a Diff / Edit toggle, so reviewing a tool's edits no longer requires scrolling between two side-by-side columns. (#93)
- Worktree UX overhaul: new worktrees are created outside the repo root (no more accidental nesting in `git status`), get Pokémon-themed names instead of UUIDs, and the new-chat panel opens instantly instead of waiting for the worktree to materialize. (#92)
- Local code index (MVP 0.04) — phases A–F land together with auto-reindex on file change, giving the agent a fast structural view of the repo without re-walking the tree on every query. (#86)

### Changed
- Renderer now has a single source of truth for the active directory and branch, replacing the previous fan-out of duplicated state across panels. (#91)

### Fixed
- Grok agent reliability on local login — the driver now uses the cached OAuth token instead of re-prompting on every session start. (#78)
- Cursor driver: ACP now fails fast on auth errors instead of silently retrying, OAuth flow is wired end-to-end, the model list is refreshed on each session, and provider errors surface in the UI instead of being swallowed. (#90)
- Settings writes occasionally raised `ENOENT` mid-rename when two writes raced. Writes through the config store are now serialized. (#89)
- Provider boot crashes: codex no longer crashes when spawned without a TTY, missing cursor binaries surface a clear error, and claude/opencode gate correctly on availability. (#88)
- Onboarding provider step tightened — copy now makes it clear that you pick a provider and go; no extra setup required. (#87)

## [0.2.1]

### Added
- "Check for Updates…" menu item that reflects all 7 `electron-updater` states (idle / checking / available / downloading / ready / error / not-available), giving users a way back into the update flow after dismissing the toast. Sits in the macOS app menu and the top of Help on Windows/Linux. About panel gets version + copyright; Help menu gains "View Changelog" and "Report an Issue"; DevTools / Force Reload move into a `Developer ▸` submenu that only appears in dev builds. (#84)
- One-click Cursor sign-in. New `agent.startLogin` streaming RPC spawns `cursor-agent login`, extracts the OAuth URL, and emits `LoginEvent`s; the renderer card replaces the old copy-and-run flow with a button that opens the URL via `shell.openExternal`, shows progress, and refreshes availability on success. (#83)

### Fixed
- Auto-update downloads that stalled mid-way were silent — `electron-updater` fires no "stuck" event. Added a 60s download-stall watchdog with one-shot auto-retry that then surfaces a retryable `error` state; the update banner now renders the `error` state with a "Try again" button and un-dismisses itself when status flips to error. (#84)
- Cursor authentication detection was trusting the existence of `~/.local/share/cursor-agent/` as proof of login, but that directory is created on install and just holds the CLI bundle — so every fresh install was flagged as signed in. Now probes `cursor-agent status` and parses the output. The blanket "Requires Cursor Pro" badge was dropped since the CLI has no whoami; the ACP server enforces the real plan check at session start. ACP auth waterfall in the cursor driver now throws a clear "not signed in" error instead of silently retrying `cursor_login` and timing out. (#83)
- Folder picker hid every dotfile directory (`~/.claude`, `~/.config`, `~/.ssh`, …) on macOS because the Electron open dialog was missing `showHiddenFiles`, making any folder under a hidden parent unreachable. The picker also now defaults to the user's home directory instead of the process cwd, so it opens somewhere useful on first launch. (#82)
- Broken `github.com/forkzero/memoize` repository URL in the native menu. (#84)

## [0.2.0]

### Added
- xAI Grok provider via the Agent Client Protocol (ACP). Picker exposes Grok models alongside Claude/Codex; sessions stream through the shared ACP transport with the same permission/tool plumbing as the other ACP providers. (#64)
- Gemini CLI provider. Adds Google's `gemini` CLI as a first-class driver; ACP v2 response types and tool-call normalization land in the same pass so tool results render correctly in the timeline. (#67)
- Cursor Agent provider via ACP. (#69)
- opencode provider with dynamic model inventory + variants. Models are fetched at runtime from the opencode catalog instead of being hardcoded, and the picker surfaces per-model variants. (#75)
- Canonical tool translator for opencode. Provider-specific tool shapes are mapped to memoize's canonical schema, `ToolUse` events are deduplicated, and stale user-echo messages are dropped from the stream so the timeline matches what other providers produce. (#77)
- User-editable keybindings backed by an on-disk config store. Settings → Keyboard shortcuts now writes through to a JSON config file; rebinds persist across launches and survive app upgrades. (#71)
- Unified ACP translator + per-model capabilities + reliable interrupt. All ACP-based providers (Grok, Gemini, Cursor, opencode) share a single translator that normalizes streamed events into canonical timeline items; per-model capability metadata gates features like images/tools at the picker; interrupt now reliably halts in-flight ACP turns instead of leaving zombie streams. (#72)
- Rich model picker: search, recents, provider chips, collapsible accordion sections, and stable `Cmd+1`–`Cmd+9` shortcuts that always map to the same top-pinned slots regardless of filter state. (#80)
- Loading affordances during chat create + per-tab streaming. Creating a new chat now shows immediate feedback while the session boots, and streaming state is tracked per-tab so background tabs keep streaming while the foreground tab is interactive. (#66)

### Changed
- Settings redesigned with a minimal frame and a lime accent. Rows are tighter, section headers are quieter, and the new primary color flows through buttons, focus rings, and toggle states. (#73)
- Top bar gains glass workflow buttons and inline "Fix" actions when CI is failing — the buttons read the latest run status and offer a one-click flow to push a fix branch. (#74)
- README rewritten end-to-end as a full memoize project overview (what it is, providers, install, contributing). (#76)
- UI polish pass: empty-state model picker matches the populated state, and Read/Edit tool result visuals now render diffs and file context in line with the rest of the timeline. (#79)
- Provider diffs cleaned up in the renderer so per-provider streams normalize into the shared timeline without provider-specific branches in UI code. (#68)

### Fixed
- Sessions with NULL `chat_id` rows (left over from the 0.1.4 chats migration on some installs) are healed on startup and the column is now `NOT NULL` at the schema level, so the nested-tab UX can't fall back into a broken state. (#70)

## [0.1.4]

### Added
- Native macOS menu bar with keyboard shortcuts: new chat (⌘N), open project (⌘O), settings (⌘,), toggle sidebars (⌘B / ⌘⌥B), toggle terminal (⌘J), focus composer (⌘L). Bindings are listed in Settings → Keyboard shortcuts (single source of truth in `lib/shortcuts.ts`) and surfaced inline on the relevant button tooltips. (#59)
- In-app update toast. Drives `electron-updater` manually instead of `checkForUpdatesAndNotify`; the bottom-right toast offers Later / Install on quit / Update now, downloads only after the user picks, and auto-installs once the download lands. Lifecycle events flow through a new `window.zuse.updates` bridge and shared `UpdateStatus` in `@zuse/wire`. (#61)
- Cross-provider switching on fresh chats. `ModelPicker` lets you pick a model from the other provider as long as the chat has no user message yet; a new `session.setProvider` RPC mirrors `setWorktree`'s fresh-session gate. The teardown path was split so `setModel` / `setProvider` / `resumeSession` only interrupt the provider event-pump fiber, keeping the renderer's `messages.stream` and `session.streamStatus` subscriptions alive across the swap. (#60)
- Codex app-server slash commands. (#62)
- Nested-tab chat UX. Sidebar rows become "chats" (a new container table); the tab strip in the main pane shows that chat's sessions as peer tabs, "+" adds a session to the active chat, and ⌘W closes the active tab via Electron menu → IPC and archives the session (auto-spawning a fresh one if it was the last). Migration 0011 backfills one chat per existing top-level session and rehomes v3 children. Adds `forked_from_session_id` / `forked_from_message_id` columns for a future fork-from-message feature. (#63)
- Codex session resume. The driver captures the codex thread id from `thread.started` and persists it as the session's resume cursor; `Codex.resumeThread(id, opts)` reattaches on next start. Codex doesn't replay prior items on resume — the renderer's persisted timeline remains the source of truth for what came before. Wire schema gained a `"codex-thread-id"` resume strategy alongside the existing `"claude-session-id"`. (#57)
- Codex image attachments. Image refs (`png`, `jpeg`, `gif`, `webp`) attached to a turn are forwarded to `runStreamed` as `local_image` items pointing at the on-disk blob; non-image refs are dropped with a warn. `AttachmentService` gained a `readPath` method so the driver can hand the SDK a file path instead of re-encoding bytes. (#57)
- Codex plan mode. The chat-header chip flipped the wire but the codex driver was hardcoded to read-only — now `plan` → codex `sandboxMode: "read-only"` and `default` / `acceptEdits` → `workspace-write`. Live toggle is implemented as `codex.resumeThread(currentId, newOptions)` since the SDK has no live sandbox-update API; the rebuild is chained onto the per-thread send queue so a toggle mid-turn doesn't race an in-flight `runStreamed`. (#57)
- Codex CLI upgrade banner. Provider availability probe now reports `cliVersionStatus` ("ok" | "outdated" | "unknown") plus a per-provider upgrade command; an inline banner above the composer prompts the user to upgrade when the installed codex CLI is below the SDK's pinned floor (currently 0.128.0). (#57)

### Changed
- Cleaner alert surfaces across `Alert`, `ErrorBubble`, `ToolErrorRow`, `CliUpgradeBanner`, `FileEditor` conflict banner, `TerminalBlock` / `PreBlock` errors, and `ErrorPill`. New dedicated tokens (`--alert-error-bg`, `--alert-warning-bg`, `--alert-info-bg`, `--alert-success-bg`) replace the loud red/yellow/amber borders + washes with soft warm-tinted card surfaces. (#58)
- Tooltip popups restyled with a frosted-glass look (translucent fill + backdrop blur). (#59)

### Fixed
- Codex CLI 0.130+ rejected `gpt-5-codex` (and bare `gpt-5`) for ChatGPT-account users; sessions died at start with a 400. Picker now uses current codex model names (`gpt-5.4` default, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) and `resolveModelSlug` aliases stale slugs through to `gpt-5.4` at both renderer load and codex driver boundaries, so an in-flight resume can't punch the bad slug through. (#58)
- Codex turn end no longer left the renderer composer stuck in "loading". `turn.completed` / `turn.failed` and the `runTurn` catch now emit `Status: idle`. (#57)
- Codex sessions on older `codex` CLIs failed with "Codex Exec exited with code 2: error: unexpected argument '--experimental-json' found". codex-sdk@0.128 hard-codes that flag; pre-0.128 binaries reject it. The server now probes `codex --version` before starting and the renderer's `CliUpgradeBanner` surfaces a friendly upgrade card; if the user sends anyway, the SDK trace is intercepted and replaced with a single-sentence chat error. (#57)

### Known limitations (Codex SDK 0.128)
- No interactive permission prompts on Codex. The SDK exposes `approvalPolicy` as static config but no JS callback to bridge approvals into memoize's toast, so codex sessions stay on `approvalPolicy: "never"` regardless of mode. Plan-mode (read-only) is the only user-facing lever; default/acceptEdits both run with full workspace-write and no prompts.
- No cross-provider sub-agents on Codex. `input.agents` is still ignored — Codex SDK has no `mcpServers` config, so the cross-provider bridge sketched in `specs/sub-agents/decisions/0012-codex-bridge-via-mcp.md` lands as a follow-up PR.

## [0.1.2]

### Fixed
- Packaged macOS app failed to start Codex sessions with "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies." Same shape as the 0.1.1 Claude fix: we don't ship the SDK's bundled native CLI, so the SDK now receives `codexPathOverride` pointing at the user's installed `codex` binary (`which codex`, with the same `fix-path`-expanded PATH). Surfaces a clean "Codex CLI not found on PATH" message when the binary genuinely isn't installed.

## [0.1.1]

### Fixed
- Packaged macOS app could not start new Claude sessions ("Native CLI binary for darwin-arm64 not found"). GUI-launched apps inherit a minimal PATH, so `which claude` never found the user's installed Claude Code binary and the SDK fell back to a bundled native CLI we don't ship. The main process now expands PATH from the user's login shell (via `fix-path`) before the runtime boots, and the server fails with a clear "Claude Code CLI not found on PATH" message when the binary genuinely isn't installed.

## [0.1.0]

### Added
- First public macOS build: signed + notarized universal `.dmg` (Apple Silicon + Intel) distributed via GitHub Releases.
- In-app auto-update via `electron-updater` against the GitHub Releases feed.
- Tag-driven CI release workflow (`v*` tags publish a draft release with the `.dmg`, `latest-mac.yml`, and blockmap).

### Changed
- Locked the macOS app to the dark appearance variant so vibrancy no longer follows the user's system theme — fixes the "faded UI on a light-mode Mac" look.
- Rebranded from `forkzero` to `memoize` (app name, custom protocol scheme, package names).
