# Zuse Slack app

First-party Slack application: account connection, repository selection, threaded
coding conversations, progress/result delivery, and configured alert automations.
No slash-command interface or customer-hosted example service.

## Ownership

`src/worker.ts` is the HTTP/queue entry point. `AppEnv` injects account-scoped cloud
operations, verified identity exchange, encrypted installation storage, and jobs.
The API's `infra/api/src/slack` adapter supplies those existing capabilities;
application behavior lives here. This is a separate workspace, **not a separately
deployed Worker yet**. HTTP callbacks remain under `api[-staging].zuse.sh/slack/*`.

- `setup.ts`: Slack installation OAuth and installer-managed alert settings.
- `accounts.ts` / `home.ts`: private per-member sign-in, success pages and App Home.
- `access.ts`: one execution-account policy shared by all task and settings paths.
- `interactions.ts` / `repositories.ts`: signed native modals and saved repository defaults.
- `agent-choice.ts`: supported cloud agent/model options from the shared curated catalog.
- `conversation.ts`: mentions, DMs, thread continuation, context/images and workspace tasks.
- `progress.ts`: native-first loading, a durable text fallback when unavailable, and one final result reply. Existing fallback cards are removed when native status takes over during preparation.
- `thread-status.ts`: shared loading-state updates and independent, version-fenced cleanup retries.
- `automation.ts` / `runner.ts`: alert matching, shared uploads/thread mappings, signed results.
- `installations.ts`: encrypted tenant/generation state and optimistic settings revisions.

Progress reports actual lifecycle activity, not private model reasoning or invented
tool output. Signed completion webhooks and a polling fallback correlate results
to the submitted turn before replacing its progress message. Token-by-token model
streaming and cancellation are not implemented.

New requests and workspace follow-ups use a short Slack attribution plus the user's
message and current attachments. Earlier thread messages and images are imported
only when Zuse is first invited into an existing thread, with quoted context marked
as untrusted instructions and the triggering message included only once. Cached
context survives retries; normal follow-ups do not re-import history.

Follow-ups require an @mention by default, including DM thread replies. New DMs
can start a task without a mention. Each member can choose **My follow-up replies**
in Home to opt into their own untagged replies in existing Zuse workspace threads.
This does not enable teammates' messages or unrelated channel conversations.
Preferences use the existing encrypted member defaults; no migration is needed.

## Local checks

```sh
bun run --cwd apps/slack check-types
bun run --cwd apps/slack test
bun run --cwd infra/api check-types
bun run --cwd infra/api test
bunx biome check apps/slack infra/api/src/slack infra/api/test/slack
```

Pure client tests live here. Full app/adapter tests remain under
`infra/api/test/slack`: isolated migration SQL, production encryption, mocked Slack
and cloud execution. They exercise signed ingress through result delivery, not a
live Slack installation.

## Installation and limits

Use [the manifest](slack-manifest.example.yaml) and the
[operator guide](../../internal-docs/cloud/slack-app-operations.md). Existing
installations must authorize the added mention/DM scopes; deploy alone is not
enough. Configure the interaction URL for the native repository selector.

Each member can privately link their own account. New installations use individual
accounts; existing installations remain installer-only until the installer chooses
otherwise. The installer can explicitly enable use of their shared account by the
team, with a warning about repository access and cloud usage. Only the account owner
can change its defaults. Apply `0023_slack_members` before deploying this upgrade.

The private Configure request modal lists up to 100 ready Zuse cloud projects with
search and lets users choose an agent/model alongside the repository. Its loading,
ready, and error views keep the same title. It does not import arbitrary GitHub
repositories. Leaving the agent blank reuses the account's existing configuration;
when those defaults are missing, agent selection is required. Recovery preselects
the saved repository but permits another ready project, preserving the original
request and images. Remember controls save only repository defaults, not the agent.
Choices use the bundled shared model catalog, not a live provider inventory. Provider
credentials must still be connected in Zuse; choosing a model does not authenticate it.
Queue concurrency stays one until durable per-thread leases are implemented.

The browser connection-complete page uses the shared integration stamp renderer
also used by the GitHub callback. Its logout action disconnects only the signed-in
Slack member's Zuse link and repository defaults; it does not uninstall Slack,
cancel running work, or sign out other Zuse sessions. A one-hour HttpOnly browser
session, same-origin POST, CSRF nonce, installation generation and connection ID
protect the action. Old pages cannot disconnect a replacement connection. After
any disconnect (including Slack Home), fresh AuthKit authorization requests
`prompt=login` and `max_age=0` for every new connection;
upstream provider account selection still needs live verification. Existing
requests are not transferred to the replacement account; start a new Slack task.

There is no authenticated one-click workspace landing route yet; replies include
the workspace ID. See the operator guide for rollout checks and scaling limits.
