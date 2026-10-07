# Slack organization selection staging deployment

## Hosted Slack workspace-link navigation, 2026-10-07

Reproduced the exact organization link in an isolated authenticated browser:
`/w/organization/org_01M3XM1CQHDGD5AQHHXTZYFVAV/chat/workspace_m9_kom1EDU5FSTJy`.
Hosted project seeding selected the first repository while the linked chat was
waiting for its runtime folder; the project-selection subscribers then cleared
its chat/session selection. Project seeding now preserves that unbound cloud
selection. Opening the actual runtime also exposed a React update loop: registering
the selected summary during project binding produced a new summary identity on
every render. The shared catalog merger now retains an already-current row's
identity while still registering its runtime-project mapping.

Frontend commits `e7219417` and `13896911` were pushed on the existing branch.
Vercel preview `dpl_8V3fEhpvApmWiWLzrdrbwAUGYzbz` is READY and assigned to
`code-staging.zuse.sh`. Branch-specific preview variables explicitly set hosted
mode, staging API, staging WorkOS client and organization support. Request-level
environment overrides were ignored on an earlier preview; it was rolled back.
A second preview exposed the binding loop and was also rolled back before the
final verified deployment. Production and main were not changed.

Validation: all 1,634 renderer tests passed, including both new regressions.
Renderer type/state checks, applicable Biome, architecture and whitespace passed.
Live browser verification of the exact link found the existing transcript
(including the analytics review), no default image_editor landing and no renderer
crash. Screenshot: `.context/slack-workspace-link-after.png`.

## Failed provider workspace and misleading Slack error, 2026-10-07

A fresh user-triggered event `Ev0C8BA62QSU` was captured live with only safe
diagnostic fields: conversation job, first attempt, API 409,
`workspace_not_accepting_messages`, operation `message_send`, nonretryable.
Authorized read-only inspection found `workspace_m9_kom1EDU5FSTJy` and
`workspace_iBAnLfKSImyKGwZX` failed/offline with `provider-unavailable` under
the QA organization. Paused workspaces accept messages and resume atomically;
this failure was specifically the failed workspace admission guard.

The earlier reply's workspace `workspace_m9_kom1EDU5FSTJy` received its normal
authenticated resume command `slack-provider-recovery-20261007`. Follow-up
inspection verified ready/online, status `agent-running`, existing chat
`chat_5890d173-ebed-4323-a682-7e1bff41d49d`, and session
`s_7aae6a4a-2bf5-4c6e-9368-6d51464456ad`. No database, sandbox, sharing policy,
credentials, or user prompt was replaced or resent. The original provider
failure's upstream cause was not captured; a provider-only tail during recovery
reported no fresh request failure. The other failed workspace was not resumed.
The fresh rejected Slack message was not submitted and needs another user send.

Worker `bae681ca-2399-4dc2-8bce-07968cde1ff8` now classifies this admission
failure explicitly and performs a bounded authorized workspace-status lookup.
It explains provider unavailability or archived/deleted state instead of
blaming Slack permissions; status lookup failure retains a workspace-specific
fallback. Polling and admission errors share one workspace-error formatter.
Existing `View in Zuse` footer and loading cleanup remain in place, and failed
admission is not automatically retried or resubmitted.

Validation: 41 Slack tests and 117 API Slack tests passed. Slack/API type checks,
applicable Biome checks, architecture and whitespace passed. The new behavior
test covers captured API 409/provider failure, explicit link, cleared status,
single submission attempt and no queue retry. All 260 deployment files matched
the authenticated Mac mirror with fingerprint
`e3dce37c78d710d258b8e5920f69bd00c2061ad1f557d416678f33e983a4fc13`.

## Workspace links in Slack, 2026-10-07

Staging Worker `12a54ee2-7b2d-42ea-9c98-f3c2d40cf8d9` replaces workspace-ID
footers with `View in Zuse` browser links. Polling, webhook delivery, errors,
existing message updates and automated-alert startup replies use the same shared
link helper and existing `cloudChatRoute` route. The link preserves the selected
organization and uses staging's configured hosted-app origin. It contains no
credentials or sharing grant; normal browser authentication and workspace
authorization still apply. Desktop protocol navigation is not added.

Validation: 41 Slack tests and 116 API Slack integration tests passed, including
personal/organization links and polling/webhook error/result delivery. Slack/API
type checks, applicable Biome checks, architecture, whitespace and staging dry-run
passed. All 260 deployment source/configuration files matched the Mac mirror,
fingerprint `f43bfff11386c3a74323e7f8db16c20a43566488c7ea8e9339b4889d9441f2a5`.
The first deployment succeeded despite the command timing out. The alert-footer
follow-up was rejected twice by Cloudflare's startup CPU validation before the
unchanged bundle succeeded. The staging web app is protected by Vercel sign-in;
an unauthenticated request to the exact workspace route reaches that sign-in gate.
Live browser workspace rendering still requires an authenticated user check.

## Slack reply formatting, 2026-10-07

Staging Worker `e5ac72cd-c2a4-47fd-9ac2-3c48d10758c4` converts agent Markdown
through the shared result-text path for both webhook and polling delivery.
Headings, bold, emphasis, lists, links and strikethrough use Slack mrkdwn;
inline/fenced code remains literal, and generated Slack mentions are escaped.
Task execution and reaction behavior are unchanged by this fix.

Validation: 39 Slack tests and 939 API tests passed (15 API tests skipped).
Slack/API type checks, applicable Biome checks, architecture boundaries,
whitespace and staging dry-run passed. The default test filter also selected
a Node-test script under Vitest; rerunning explicit API test directories passed.
The authenticated deployment mirror matched the tested 257-file fingerprint
`3123b6135cbc6273db8fe5bf8a0548fddbc6317f538d560d95fb2b36a6daf30e`.
Live Slack rendering still needs a new reply in the Slack client.

The API was deployed to `https://api-staging.zuse.sh` on 2026-10-07.
Authenticated organization selection still requires the user's live Slack test.

- Worker: `zuse-relay-staging`.
- Version: `77f1bc22-30a1-4021-b80b-994c066b6e11`, confirmed at 100% traffic.
- Activated: `2026-10-07T07:46:49.407Z`.
- Previous version: `646216c5-0ef7-4339-a5d8-a422c572bd99`.
- Source fingerprint: `fcc9a9d7427dcf99d403e169b0aa2066c66fdb4196506b2b42a18615e8d747c6`.
  All 248 source/configuration files matched the authenticated Mac mirror.
- Frozen dependency install and staging/production Wrangler dry-runs passed.
- No database migration, production deployment, merge, or runtime publication.

## Included

After WorkOS sign-in, accounts with accessible organizations can choose Personal
or an organization before their Slack connection is persisted. The selected
organization scopes repositories, new workspaces, webhooks, and cloud usage.
Each API operation checks current membership and applies workspace sharing
permissions. Existing connections remain Personal until disconnected/reconnected.
The source also adds actor propagation to runtime API commands; the server change
will take effect when an updated runtime is published.

## Verification

- API behavior tests: 868 passed, 12 skipped; Slack: 34 passed.
- Three deployment-compatibility tests passed with the Node test runner. The broader
  Vitest invocation also discovered that Node test file and reported it as an empty
  Vitest suite; all actual API Vitest suites passed.
- Prior feature checks: 235 focused tests, applicable type checks, Biome, architecture
  boundaries, and whitespace checks passed.
- Nine live HTTP checks passed: Slack landing 200; installation 303 with the staging
  Slack callback; invalid connection token, unauthenticated setup/projects, unsigned
  events/interactions, and unauthenticated organization POST 401; organization GET 405.

## User test

Use the staging Slack app's Home tab. Disconnect the existing connection, connect
again, sign in, choose an organization, and verify its ready repositories appear.
Use a fresh connection link; consumed OAuth callback URLs cannot restart selection.

## WorkOS selection correction

At `2026-10-07T10:01:48.647Z`, version
`b2e0f059-1dc7-4534-9a72-e54cded30983` replaced the earlier version at 100%
traffic. The duplicate Zuse organization chooser and its form endpoint were
removed. Slack now uses the organization claim from the verified WorkOS token,
validates current content access, and resolves the organization's display name.
A token without an organization continues to use Personal.

The corrected 248-file source fingerprint is
`85e13e7be9b602373e023ede92262de7a6180e765bb217426fbc69eb29ed4136`;
the Mac deployment mirror matched. Staging dry-run, 174 focused tests, API/Slack
type checks, applicable Biome checks, and architecture checks passed. Live checks
confirmed landing 200, installation 303, invalid connection 401, unsigned events
401, and removal of the old organization endpoint (404). Reconnect from Slack to
test the single WorkOS chooser. No production deployment or migration was applied.

## Workspace task access clarification

At `2026-10-07T10:06:54.224Z`, version
`1a6d688a-9524-4b65-8411-d0dcf028ce85` became active at 100% traffic.
App Home now labels the policy **Workspace task access**, identifies the installer
who manages it, and shows its current mode read-only to other members. Options
refer to the installer rather than ambiguous "me"/"my" wording. The existing
installer-only checks at interaction admission and queued execution remain in force.

Source fingerprint:
`f2692b593341549b553f041be90ac1ca83d732ac8c5f5dcaa75c86dd02fe1c88`.
The 248-file Mac mirror matched. Staging dry-run, 143 Slack/app tests,
API/Slack type checks, applicable Biome checks, and whitespace checks passed.
Live HTTP checks passed for landing (200), install (303), and unsigned interactions
(401). Reopen App Home to see the updated wording and controls.

## Execution defaults and main rebase

Rebased the workspace onto `origin/main` at `89d26ac6` without conflicts. At
`2026-10-07T10:20:58.179Z`, version `1093bbc0-4eb3-4395-b862-9294c9bb9378`
was activated at 100% staging traffic.

Slack Home now offers independent Agent, Model, and Sandbox provider choices for
the owner of the active connection. Available sandbox providers come from the
shared cloud provider listing, scoped to the selected account or organization.
New workspaces and alert automations use the saved defaults; existing threads
keep their workspaces. Queued changes check current ownership and revisions,
validate catalog membership, and use the existing optimistic member persistence.
Shared-account members cannot override the installer's settings.

All 251 source/configuration files matched the deployment mirror with fingerprint
`dc46ad220df4f0ebbb395a34ec3f98c49263d33f2bef5e1c48a502779a627757`.
Frozen dependencies, staging dry-run, Biome, architecture checks, whitespace checks,
and API/Slack/contracts/server type checks passed. Focused behavior tests passed
176 tests; the complete API suite passed 896 tests with 15 skipped. Live checks
cover Slack landing, install redirect, rejected unsigned requests, and protected
provider listing. Reopen the staging Slack app's Home tab to test the defaults.
Desktop organization visibility still depends on the installed desktop build and
the account's API capabilities; this API deployment does not update that build.

## Missing agent CLI and explicit Slack defaults

At `2026-10-07T10:36:33.667Z`, version
`c43bd81c-ca27-4b45-88b5-7f532e7c9ae3` activated at 100% staging traffic.
The live incident matched the screenshot's exact Slack request in the encrypted
checkpoint of `workspace_VRfYGRQ0Y1h9sjZu`. The Grok runtime repeatedly persisted
`Grok CLI not found on PATH` while leaving the turn running. The public integration
ledger therefore reported outstanding work, and Slack never received settlement.
Grok had been inherited from the organization's most recent workspace.

Slack now requires an explicit saved or per-task agent/model choice instead of
inheriting another workspace's choice. Home's unset agent option says **Choose
when starting a task**. Message polling exposes a missing-CLI diagnostic from the
current authenticated checkpoint, bound to the submitted message and turn. Slack
replaces loading with instructions to select another agent and start a new thread.
It clears native status and stops polling; this does not fabricate a runtime
settlement or stop the older runtime's own retries. No runtime publication was
performed. Existing threads keep their workspace/agent.

The 252-file deployment fingerprint matched:
`e824b9dcaa6223ddfc163b95a780f5c701871f0582ec28276cced2297923c19f`.
A regression test first reproduced the stuck Slack indicator, then passed with
this fix, including rejection of another turn's diagnostic. Integration tests
cover encrypted checkpoint reading, message/turn correlation, active versus error
status, ciphertext integrity, generation fencing, and explicit agent defaults.
178 focused tests and the full API suite (898 passed, 15 skipped) passed. API/Slack
type checks, Biome, architecture checks, staging dry-run, and whitespace checks
passed. Basic live checks confirm Slack landing, installation, and rejected
unsigned interactions. The user's original Slack thread still requires visual
confirmation of the error card after its next recovery poll.

## General agent error reporting

At `2026-10-07T10:42:27.363Z`, version
`c506d099-a55a-453b-a39b-16ec2ad533c8` activated at 100% staging traffic.
The checkpoint diagnostic now covers terminal agent errors generally, including
failed settled turns whose current turn has cleared, while preserving exact
message/turn and generation checks. `turnFailure` includes a bounded recorded
error. Missing CLI diagnostics retain the earlier `startupFailure` response for
compatibility. Shared Slack formatting escapes error detail and provides recovery
guidance; both polling and signed webhook delivery use it. Failed outcomes with no
diagnostic still explicitly report failure. Slack clears loading and stops result
polling when it reports a terminal error; runtime behavior is not modified.

Regression tests first reproduced stuck polling for authentication, model, and
connection errors. Focused verification passed 184 tests, including failed turn
handling through polling and webhooks and absent diagnostic fallback. The broader
API suite passed 903 tests with 15 skipped before the final fallback wording test.
API/Slack type checks, Biome, architecture checks, staging dry-run, and whitespace
checks passed. The 253-file deployment fingerprint matched the tested workspace:
`4b4e57601c9bec4e93685ecbd7c965a169a254c8f911834d104e4e6f40d5d652`.
Basic live checks cover Slack landing, install redirect, and unsigned interaction
rejection. Authenticated live error rendering remains a user test.

## Message reactions instead of working cards

At `2026-10-07T10:49:26.290Z`, version
`7c6ac484-475b-4e65-85ff-df12b3806b25` activated at 100% staging traffic.
Conversation jobs acknowledge the original message with `eyes`. Work adds
`one_sec_cooking` alongside native Slack status, with `hourglass_flowing_sand`
fallback only when Slack reports an invalid custom emoji. Completion/errors
remove the working reaction and clear native status; eyes remains. Follow-ups
react to their own message, not the root thread. New progress no longer posts
working cards, and older persisted loading cards are removed during preparation.
Actual result/error messages remain in the thread.

Transient reaction removal failures enqueue independent cleanup with generation
and version checks, so stale cleanup cannot remove a later reaction. Reaction
permission/name failures cannot prevent task execution. OAuth requests and the
example manifest now include bot scope `reactions:write`. Existing staging
installations must reauthorize at `https://api-staging.zuse.sh/slack/install`;
OAuth consent and live rendering remain a user step.

The 254-file source fingerprint matched the authenticated deployment mirror:
`4271c9395faac9988d509d2ac876995902b93fb4df050a95aa84237a486253e4`.
Focused tests passed 190 tests; full API tests passed 910 with 15 skipped.
API/Slack type checks, Biome, architecture, whitespace, and staging dry-run
passed. Tests cover original/follow-up message targeting, native status both
available and unavailable, emoji fallback, missing permission, and retry/stale
cleanup. Live install redirect requests the reaction scope; landing and unsigned
interaction checks passed. No production deployment or runtime publication.

## Agent picker defaults and trimmed failure history

At `2026-10-07T12:11:22.697Z`, version
`4ad1b74d-30d5-4e95-a4d6-a966a1688c4c` became active at 100% staging traffic.
The 254-file deployment mirror matched fingerprint
`82a1aa398d70e973e52930e17aa55d339ef041fa45046ef9fdeed8d6a21bec07`.

The private picker now offers **Use this agent and model for future requests**,
initially checked when the active connection has no agent default. Persistence
uses the existing member revision and connection-owner guards. Unchecked choices
remain per-request; existing workspace threads retain their existing agent.
A safe queue diagnostic records accepted agent/model and whether defaults were
saved, without request content, credentials, or user identity.

Live inspection before this deployment showed no newly created Sonnet workspace
in the user's personal scope or either accessible organization. The older Grok
workspace was repeatedly recording missing-CLI errors; its original user message
had fallen out of the checkpoint head. Failure diagnostics now correlate a trimmed
head using its authenticated current turn and reject errors older than submission.
A settled checkpoint without either the user message or a current turn is ignored.
The exact cause of the user's earlier Sonnet submission remains unverified and
requires a fresh Slack test to capture the accepted-selection diagnostic.

Regression tests reproduced both missing default persistence and the trimmed-head
failure before changes. Focused tests passed 191; the full API suite passed 911
with 15 skipped. API/Slack types, applicable Biome, architecture, whitespace checks,
and staging dry-run passed. Live smoke checks: Slack landing 200, install 303 with
reaction scope, unsigned interactions 401. No runtime publication or production
change was made.

## Live startup failure: missing staging migration

The subsequent Slack test exposed a deployment prerequisite missed after rebasing
onto main: migration `0038_cloud_snapshot_storage` had not been applied. A guarded
read-only Hyperdrive query confirmed all three new tables were absent and the
latest Drizzle journal entry was 0037 (`1790985600000`). Both saved-image
maintenance and workspace creation use these tables. The failed staging queue
contained the earlier Sonnet selection and subsequent conversation request.

Verified Hyperdrive `dfc67e0586ff4c288cb645ed63c65d9a` targets the approved staging
origin `db.yzawvredrbpcwbzdnxsu.supabase.co`, database `postgres`. Applied the existing
0038 SQL and its exact SHA-256/Drizzle timestamp journal entry in one transaction,
with a prior-journal guard and bounded lock/statement timeouts. Post-commit checks
confirmed snapshot, lease, and price tables exist; two stored image identities were
backfilled by the migration's existing SQL. The first migration response was not
JSON; a separate schema check confirmed it had not committed before retrying.
The successful guarded retry committed all changes. No existing data was dropped.

Temporary authenticated inspection/migration Workers were deleted. The failed
queue's temporary HTTP-pull consumer was removed, and no messages were acknowledged
or deleted. Historical telemetry was inaccessible with the available credentials;
a timed live capture supplied the fresh request's failure/recovery evidence.

The user's fresh request retried automatically after migration, created
`workspace_qXDwztmnsbReETZT`, selected `claude` / `claude-fable-5-1`, became ready,
and persisted its API message. Its encrypted transcript then reported
`claude-auth-reconnect-required`. Storage-aware refresh of the organization's cloud
auth authority succeeded and confirmed Claude is disconnected for
`org_01M3XM1CQHDGD5AQHHXTZYFVAV` (Zuse QA 20261002). Provider sign-in requires the
user; no credentials were copied between personal and organization scopes.
Slack also reports `missing_scope` for reactions; reauthorization remains required.

Slack's shared terminal-error formatter now gives a direct cloud agent reconnect
instruction for the exact broker reconnect-required code. The regression failed
before the formatter change and passed afterward. Focused behavior tests: 192
passed; API/Slack types, Biome, architecture, whitespace and staging dry-run passed.
The operations runbook now requires checking/applying every migration before an
API deployment rather than only the original Slack member migration.

Reconnect guidance deployed as staging version
`fc35a267-d24c-4334-9f9a-224421fc7c0c` at 100% traffic, with the 254-file source
fingerprint `96c0cdc0df9a0bc1adbd86335342f01b9e63084c7f959b5bd339b8114e82053f`
matching the Mac mirror. Live Slack landing returned 200.

## Connected-agent selectors and native desktop repair

Slack now obtains available agents from cached cloud authentication status scoped
to the active account/organization, through `/v1/api/agents`. Only connected
providers on a ready authority are returned. The response contains agent IDs only.
The same helper is used by listing and internal Slack workspace creation guards;
status reads do not wake the auth authority. Home and picker options are filtered,
empty availability has no Start button, and malformed/unavailable responses fail
closed. Modal submission and queued acceptance revalidate agent authorization.
Saved disconnected defaults prompt a new connected choice before creating a task.
CLI installation/model entitlement checks remain runtime diagnostics.

Tests cover filtered Home/popup, empty availability, rejected disconnected choices,
revocation after queueing, and the real API's listing/create guard. Focused tests:
196 passed. Full API suite: 916 passed, 15 skipped (existing optional suites).
API/Slack types, Biome, architecture, whitespace, and staging dry-run passed.
The tested 254-file Mac mirror fingerprint is
`cb05bded2ee3dcdd964fbae870cbcb35b8423c1bd9e0c35d9b6851d06b2d6610`.

On the user's Mac mirror, the reported desktop startup exception was caused by
missing `node_modules/keytar/build/Release/keytar.node`. Rebuilt the hoisted keytar
module using the installed Electron 42.4.1 target. Verified `require("keytar")`
succeeds inside Electron with `ELECTRON_RUN_AS_NODE=1`. No credential-store reads,
credential copies, desktop restart, or native source changes were performed.

Deployed connected-agent filtering as staging version
`a5bc4719-cf76-45ab-a23e-db2e3d72b01f`, confirmed at 100% traffic. Live checks:
Slack landing 200; unauthenticated agent listing 401.

## Grok CLI recovery

The QA organization's recent Grok workspaces `workspace_iBAnLfKSImyKGwZX`
and `workspace_gCd7JhKMhZYGXttp` forked an older account image without Grok.
Their connected auth status did not establish that the CLI was installed.
Using each workspace's authorized, repository-scoped terminal, installed pinned
Grok 1.0.13 into `/home/zuse/.local/bin`. No runtime restart, database migration,
credential copy, or prompt resubmission was used. The existing turns retried and
completed: checkpoints showed assistant responses at 14:50 UTC with no current
turn remaining.

Template provisioning and workspace launch/resume now share `install-grok.sh`,
including versioned binary generation and digest pins, bounded download/install, and executable
verification. Older snapshots install the missing CLI before starting their
runtime. Installation failures fail startup with `installing-agent-cli` rather
than starting a runtime whose Grok requests cannot execute. Already installed
Grok is preserved. This repairs tool availability independently of signed runtime
publication or account-image rebuilds.

Grok recovery deployed to staging as Worker version
`8e49f9ec-1e4d-4277-bd08-f8bb1f6c1bd1`. Source fingerprint: 256 files,
`70bfb2118e1c1935425806bb8fbe020ec0dadf98063b30eee277778441cc3a8a`.
Cloudflare rejected the first attempt for startup CPU; retry succeeded. Full API
suite: 939 passed, 15 skipped. API/Slack/server type checks, changed TypeScript
Biome checks, shell syntax, architecture boundaries, and whitespace checks passed.
The older original workspace `workspace_VRfYGRQ0Y1h9sjZu` denied the scoped terminal
RPC; no runtime/database/credential changes were made there. Its CLI prevention
applies on the next authorized start or restart; the two recent workspaces were
repaired and their original turns completed without resubmission.

## Provider startup replay fix (publication pending)

The minute-by-minute duplicate Grok errors came from `handleProviderTurn`: when
startup failed, it deleted the durable effect receipt and threw. Catch-up then
executed the same startup again indefinitely. Commit
`9f39dcd3fa87bf0ac093e3a63f0cb8a6288d8223` acknowledges that automatic effect before
propagating its first failure. The original durable turn remains available for
explicit session Retry. Queue resume uses that existing retry seam so restored
queue items can still deliver once. Authentication failures retain their existing
explicit recovery behavior, and ambiguous deliveries still never replay.

Validation: 137 provider/receipt/conversation/event behavior tests passed, server
types and architecture checks passed, and changed core/unit files pass Biome.
The existing conversation integration file has 10 pre-existing non-null assertion
warnings; no unrelated unsafe lint fixes were applied.

This is a server runtime change; deploying only the API does not apply it.
Attempted to push the current branch and dispatch `cloud-runtime-staging.yml` with
`publish_target=staging` and `confirm_non_main_staging=true`. GitHub rejected pushes
from both cloud and Mac connections with Internal Server Error and rejected
workflow dispatch with HTTP 500 (15:08–15:10 UTC). No signed runtime containing
this fix has been published. The active staging runtime remains the previous
`bea98a55` build; restart alone does not install the retry fix yet. The local
commit and `.context/provider-retry-fix.bundle` preserve the tested change.

## Responsive desktop activity for Slack-started turns

Commit `cad4603b` makes the shared cloud activity projection honor a connected
live runtime's current turn before the control-plane workspace summary catches
up. Booting turns show `starting-agent` immediately, and running/stopping turns
remain interruptible. Chat setup no longer suppresses the working row once
actual live work is visible. Paused/failed workspaces and auth failures still
win; cached/checkpoint history does not establish running work.

54 focused renderer tests passed, including a rendered composer Stop-button
regression, along with renderer types, Biome, architecture, and whitespace checks.
The changed renderer source is synced to the user's Mac; their installed
`/Applications/Zuse (Beta).app` requires a desktop build containing this change.
No installed application bundle was modified.

GitHub recovered and both commits were pushed to the existing branch. The signed
staging runtime was built, signature/archive verified, smoke-tested, and published
by [run 37644108824](https://github.com/swarajbachu/zuse/actions/runs/37644108824).
The staging manifest now names `cad4603b8a97f868052c57119aad57ca872fe46d`, and the
active staging API already points to that channel. New workspace starts and
explicit restarts receive the provider replay fix. Existing running workspaces
were not forcibly restarted. This runtime publication does not update the
installed desktop renderer; that remains a separate desktop build.
