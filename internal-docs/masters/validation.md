# Zots validation

## Guided onboarding follow-up

Implemented on `swarajbachu/zots-onboarding` from main `f82f2bf79`. The five-step guide uses native controls and scoped target markers; it stores only versioned, device-local guide progress. It does not change server state, grant permissions or send an example brief.

Final checks passed: 2,088 renderer tests across 330 files, renderer types/state ownership, architecture, Biome (including a separate size-limit override for generated translation context), localization (3,662 desktop messages), and production bundle budgets. Browser walkthroughs against isolated data verified all steps, draft-preserving example insertion without message delivery, dismissal/replay/resume, automatic first-use focus, focus return, missing-coordinator fallback, user-owned panel visibility, and all five cards at 720px. No paid provider turns or real user data were used. A fresh standalone browser profile required explicit desktop catalog initialization to simulate native IPC; native desktop uses its existing initialization path.

### Onboarding UX pass

The welcome card now lists the four-step plan (each row jumps to its step), later cards are shorter with a progress indicator and a close button, and Details stays open for the whole guide so the composer no longer resizes between steps. The empty Zot offers three example briefs that insert editable text into its own composer and never send. Checks: renderer types/state, Biome, localization (3,674 messages) and 2,089 renderer tests passed; browser walkthroughs at 1440px and 720px against an isolated copy of the QA data.

## October 22 integrated PR candidate

Base: `3db1391a2`, with the full backend and renderer changes integrated. Product wording is Zot/Zots; durable identifiers remain `master` for compatibility.

- Full server suite: **226 files, 1,652 passed, two skipped**. Following the wording/capability changes, 26 supervision tests and the real-server restart test passed again.
- Renderer unit suite: **327 files, 2,056 passed**, including direct and artifact-viewer checks that disabled screens render hostile HTML only as escaped text.
- Scoped API ownership/grant/migration tests: **19 passed**. The broader API suite reports 1,252 passed, nine failed, 21 skipped, and four node:test script collection failures. All nine failing API assertions reproduce on the clean `3db1391a2` worktree (56 other assertions passed); they concern deployment prerequisites/config and legacy recovery expectations. They are not a passing API suite.
- Agents: 39 focused orchestration/lifecycle tests; CLI: 30 tests; real-server restart: one test passed.
- Actual current Stable `v0.24.0` → candidate → Stable → candidate: all four stages passed, preserving ordinary data, Zot history, topic/artifact versions and command receipts; probe tests also pass.
- Renderer/server/API types, architecture, localization and scoped Biome pass. Biome reports existing warnings and skips the generated desktop context JSON above its size limit; localization checks validate it separately.
- Renderer production build passes bundle budgets. Desktop build and startup smoke pass. Corrected Electron package launch and dynamic port allocation allow cold start and create/stop scenarios to pass; the chat/relaunch scenario still stops at command-palette assertions (initial shortcut timing, then command ordering on rerun).
- Browser smoke against isolated data covers settings, repository edits, history, shared model selection, workers, responsive layouts and draft retention across renaming. No paid provider or authenticated cloud mutation was performed.

Generated HTML execution is disabled because iframe script isolation alone does not enforce network isolation. Stored artifacts and native controls remain available. Cross-environment dispatch and home transfer are also disabled by default. No Preview has been published by this PR.

## Historical validation

The entries below record earlier snapshots, not certification of the final candidate.

Validated in the isolated Linux workspace after rebasing onto `272752f2` (`origin/main` at rebase time).

## Automated checks

| Check | Result |
| --- | --- |
| Biome on all 64 changed TypeScript/JSON files | Passed; existing warnings in chat composer/workspace code remain |
| Types: server, renderer, API, contracts, agents, client runtime, system tests | Passed |
| Architecture boundaries and renderer state ownership | Passed |
| Desktop build and bundled startup smoke check | Passed |
| Localization generation/checks | Passed: 2,529 desktop messages, seven languages and pseudo-language |
| Server unit suite | 440 passed |
| Server integration suite | 258 passed; subsequently expanded Zots supervision suite passed all eight cases |
| API unit/integration suites | 279 / 54 passed |
| Agent unit suite | 271 passed |
| Renderer unit suite | 838 passed |
| i18n package tests | 22 passed, plus localization script tests |
| Real-server Zots restart system test | Passed |

The final focused supervision run covers lost delegation acknowledgments, lost home staging/activation acknowledgments, coordinator renewal, denial and follow-up limits, unacknowledged work after stop, disconnected interruption delivery, and repository detachment. It uses two independent SQLite-backed homes and simulated authenticated transport. The separate peer-auth and API grant tests verify Zot/account/source scope and reject credentials presented to the wrong protocol.

## Browser checks

The browser connected to a real isolated server with 100 existing repository chats, without starting paid provider turns. Verified board layout at desktop and 800px widths, no right utility sidebar in Zots, fresh-chat history, settings and task model profiles, explicit unavailable models, pause/resume, and opening a chat with a return path to its Zot. Six concurrent summary streams each received initial and updated 100-chat summaries in approximately 2.5 seconds; an individual summary request was approximately 60ms. Transcripts and generated screens load on demand.

Generated-screen checks confirmed denied parent-document access, scoped summary reads, a pending native approval before mutation, and a todo appearing only after Run action. Screenshots are retained in the workspace `.context` directory.

## Validation still needed outside this VM

The packaged Electron interaction suite produced one pass, four failures and one platform skip. Existing `file://` JavaScript chunks fail to load before Zots opens. A separately built `origin/main` renderer reproduces the same failure in this Electron harness, so this is not attributed to the implementation. Native packaged interactions need a working desktop environment.

No production cloud credentials or paid provider turns were used. Deploy API migration 0040 and the scoped Zot ownership/connect endpoints before exercising account-managed cross-environment Zots. Complete a real linked local/cloud delegation and home-transfer smoke check after deployment.

## Creation and form regression (September 14)

The affected Mac's Node runtime reproduced HTTP 404 `not_found` from the Zots authority endpoint. A partial local record already existed with no active coordinator. New regression tests failed before the fix (local creation rejected; remote failure left a record) and pass after it. Local creation now tolerates an undeployed authority route; remote creation still requires registration before saving a Zot. Incomplete older records reopen in settings and retain their configuration. Zot errors preserve their reason through Effect failures, and the form retains a command ID for retries of unchanged creation input.

The form now uses shared Input, Select, Textarea, CheckboxInput and Button components, General/Guidance tabs, and a fixed action footer. Browser checks at 1180×820 and 800×650 verified creation, editing, provider menus, model profiles, 28px controls, visible actions, and no horizontal overflow. Screenshot: `.context/masters-settings-compact.png`.

Final checks passed: Biome, server/renderer types, architecture, localization (2,531 messages), renderer production build/bundle budgets, 15 focused server behavior tests and the real-server restart test. The earlier TooltipProvider/useMemo crash was not reproduced with either the default cache or the same custom cache layout used by the Mac; no speculative React change was made. The Mac dev server stopped before its live module URLs could be inspected.

## React cache and shared model picker follow-up

Reproduced the exact `Cannot read properties of null (reading 'useSyncExternalStore')` failure with a Vite fixture that advances React's optimizer generation while ReactDOM's entry URL remains stable. Immutable browser caching retained ReactDOM's previous React import. Development responses now use `Cache-Control: no-cache`, allowing revalidation without disabling storage. The same fixture passes with the real renderer configuration. `bun run test:renderer-cache` passed on Linux and on the affected Mac. Its generated Vite cache was backed up and the dev runner restarted; served ReactDOM, resizable panels and TooltipProvider imports all reference one React URL, and the restarted dev log contains no repeat hook errors.

Zots coordinator and task-profile controls now use the existing ModelPicker, with the same trigger styling as Settings. The catalog store caches and deduplicates requests per environment and rejects results from an earlier reset. New Zots use the user's configured defaults; editing uses the active coordinator's provider/model. Browser checks verified a coordinator selection persists after save/reopen without changing the global default. General and Guidance reuse SettingsGroup and SettingsRow. Screenshot: `.context/masters-shared-settings.png`.

Validation: all 840 renderer unit tests, renderer types/state checks, Biome, architecture checks, localization (2,532 desktop messages), production renderer build/bundle budgets, and the cache regression passed. No production caching policy was changed; the header applies to the Vite development server.

## Composer acceptance and coordinator role follow-up

A live send receipt was coupled to timeline reflection, so an accepted message could remain in the composer while the stream caught up. The ClientBus regression failed before the fix and passes after separating acceptance from reflection. The outbox and pending message still remain until reflection; failed acceptance preserves the draft. Renderer coverage includes screenshot attachments and a later draft surviving delayed reflection.

The rendered Zot composer was also exercised with a held send receipt at the command executor boundary: text stayed before acknowledgment, cleared after acknowledgment, and the next draft survived reflection. No provider turn was dispatched by this browser probe. The temporary executor override and probe outbox entry were removed afterward.

The Zot prompt now explicitly delegates repository implementation, including small tasks, and prohibits taking over blocked workers. A creation/renewal integration test verifies the instructions reach the private workspace. Provider startup and resume inject the same prompt; already-running provider turns retain their existing instructions.

## Immediate submission and native context correction

The earlier acknowledgment change still left the composer visible during network latency. Submission now clears text, attachment chips, and annotations synchronously, with a captured draft restored on failure. Recovery preserves newer draft text and chip offsets. Delayed-acknowledgment, rejection, and recovery tests cover the shared composer path.

The affected Mac's Codex rollout confirmed the Zot role was missing from its native developer message. Optional Zot services had been looked up in the ambient execution context rather than the captured conversation runtime. A regression reproduces that missing role outside an RPC context and verifies both instructions and session-bound tools after the fix. Coordinators receive their role instead of generic repository-worker guidance. Codex lifecycle tests verify the policy is sent through `developerInstructions` on start and resume, separately from user turn input.

`zuse master state --session <coordinator-id>` and `zuse master action --session <coordinator-id> --command-id <stable-id> --json @action.json` use the same session-scoped router as MCP. CLI actions retain Plan mode, active-coordinator ownership, and retry receipts. Development providers receive a command pointing to the current checkout's CLI. A live CLI read succeeded for the affected Zot on the Mac's running `port-5734` instance.

The Mac also contained a saved Pi resume event that prevented this branch from starting. The persistence schema now preserves `pi-session-file`; replay regression passes without modifying history. Repository catalog defects now retain last-known summaries and report an unavailable environment instead of taking down the entire Zot query. This does not add the Pi provider to this branch: its incompatible saved sessions remain unavailable here.

Final checks for this follow-up: 842 renderer unit tests, 265 server integration tests, 14 focused Zot tests after catalog fault isolation, 61 domain unit tests, 11 CLI tests, and 24 Codex lifecycle tests passed. Applicable server, renderer, agent, CLI, and domain types and architecture checks passed. Biome passed (the large existing composer file retains pre-existing lint warnings). The browser smoke check showed the submitted text clearing immediately. Native Mac CLI state was verified against the affected coordinator; its provider was reopened without submitting a new task.

## Main rebase (October 3)

Rebased onto `f3e70454` with the Zots work restored uncommitted. Resolved conflicts against organization workspace navigation, context attachments, provider authentication/model catalogs, provider instructions, and localization. Retained main's streamed model updates and cache ordering together with environment-qualified Zot model selection. Failed optimistic sends also restore main's context attachments.

Renumbered the additive Zots migrations to SQLite 0063 and API 0034. Added coverage for a database whose latest migration is the earlier Zots slot 58, including two restarts; existing Zot tables survive while main's question-delivery schema is applied and its ledger repaired.

Checks passed: renderer/server/API/agents/CLI types, architecture boundaries, localization, 1,590 renderer unit tests, 330 server integration tests, 19 focused API tests, 32 agent tests, 70 client-bus tests, and 11 CLI tests. Biome completed with existing warnings. This rebase did not repeat the earlier desktop/browser or live cloud checks.

## Main rebase (October 9)

Rebased onto `a9179f56` while preserving the subsequent UI/UX work, including shared sidebar rows/top-bar controls, measured composer height, and the Zots activity views. The pre-rebase working tree and untracked files remain backed up in the October 9 stash.

Combined main's thread-list sidebar, dynamic ACP provider handling, cloud CLI routing, and provider-account/workspace migrations with Zots. Moved Zots to SQLite migration 0065 and API migration 0040. A regression test reproduces the previous branch's slot-63 database, checks preserved Zot data and main's workspace/account schemas, and repeats startup. The API table creation also tolerates an earlier Zots development migration.

Passed: renderer/server/API/CLI types, Biome (existing warnings), architecture, localization, 345 server integration tests, 19 focused API tests, and 24 CLI tests. Renderer tests: 1,696 passed, one file-search shortcut test failed; that identical failure reproduces on a detached clean `a9179f56` checkout. The test asserts synchronously after main's deferred command dispatch. No desktop/browser interaction tests were repeated for this rebase.
