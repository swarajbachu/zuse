# GitHub connection and repository-scoped user credentials

**Connect GitHub** is the single Cloud Workspace connection flow. The user chooses
which repositories the Zuse GitHub App can access and authorizes Zuse to act as
them. There is no separate personal identity connection or manual token entry.
The callback keeps the shared GitHub authorization flow: browser nonce and
origin checks, current workspace membership, and an explicit installation chooser. Administrators
can link approved installations as GitHub owners or active organization members
with writable repository access; Zuse workspace members can choose installations already
linked to the organization. Credentials
are encrypted into the short-lived signed chooser state and persisted with the
selected installation only when the user confirms. No plaintext parent token
is sent to the browser or sandbox. User credentials belong to the connecting Zuse account. Organization installation
links remain shared, but credentials are never borrowed from another member.

For each workspace, the API calls GitHub's
`POST /applications/{client_id}/token/scoped` with the parent user access token,
repository owner as `target`, and exactly one repository in `repositories`.
Only the resulting repository-scoped user token reaches the sandbox's Git/`gh`
credential broker. GitHub enforces the repository restriction on the token itself;
checking a repository with a broad token would not provide this restriction.
The parent access token and refresh token stay encrypted on the API server.
Neither credential is baked into sandbox images.

Commits use the authenticated user's display name and GitHub private commit
email (`ID+LOGIN@users.noreply.github.com`). Cloud agent processes receive explicit author and committer environment variables. This supplies authorship, not cryptographic signing.
Pushes and PRs use the repository-scoped user token. Image builds continue to
use installation credentials independently of agent activity.

## Enable and roll out

1. Apply migration `0034_cloud_github_users` before deploying the API.
2. Configure `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and the existing
   `CLOUD_DATA_ENCRYPTION_KEY`. Keep the app private-key configuration used for
   installation metadata and image builds.
3. Register the user authorization callback URLs:
   - `https://api.zuse.sh/v1/cloud/github/callback`
   - `https://api-staging.zuse.sh/v1/cloud/github/callback`
4. Keep expiring user access tokens enabled. The app needs Contents and Pull
   requests write permissions for pushes and PRs, plus Members read permission
   to verify organization administration. Branch protection and organization
   restrictions continue to apply.
5. Retain main's OAuth and installation Setup URL flow. Connect GitHub opens
   OAuth and then the account chooser; users without an installation first
   install the app. Registration callbacks must use the configured API origin.
6. Deploy the updated API, server runtime, and desktop UI. Existing users choose
   **Connect GitHub** once to upgrade an installation-only connection. Restart
   existing workspaces afterward; updated runtimes clear cached credentials and
   configure commit identity before launching agents.

## Organization installation approval handoff

A Zuse workspace administrator can connect an approved GitHub organization
installation as an active GitHub organization member. The GitHub owner only
approves the app on GitHub; they do not need a Zuse account. The requester keeps
their workspace-bound signed connection state while waiting. The waiting tab
checks approval with bounded backoff while visible and resumes authorization
when an eligible organization appears. **Check approval** retries manually;
starting **Connect GitHub** again recovers after closing the tab. These checks
read GitHub directly, so missed webhooks do not block completion. Existing
installations use the same chooser without reinstalling.

Member-created installation links persist only repositories GitHub exposes as
writable through the requester's user token, capped at 500 repositories. GitHub
enforces this allowlist on image-build installation tokens, and bot/user
credential delivery also checks it. A chooser POST rechecks current membership,
repository access, and Zuse workspace administration before storing the link.
Metadata reconciliation and webhooks preserve the allowlist; they cannot expand
the workspace grant. Owner-authorized links retain their existing full
installation scope. Apply `0045_github_member_repository_scope` before deploying
this API change. No founder credentials or webhook-driven workspace links are
created by the handoff.

No live GitHub App settings, deployments, or sandbox databases are changed by
this implementation. Older runtimes need updating for commit authorship support.

## Refresh and failures

Per-account database locks serialize authorization, refresh, and disconnect.
Rotated parent tokens are persisted before minting repository-scoped tokens, so
a repository denial cannot roll back a consumed refresh token. API requests have
bounded timeouts. The broker caches scoped tokens no later than their actual
expiry or the parent token's expiry.

Missing authorization, revoked access, and failures to mint a scoped token stop
credential delivery. The broker never falls back to the parent token or a bot.
Users reconnect through the same **Connect GitHub** action. For personal workspaces, removing the last
linked installation revokes the user's app authorization (including associated
scoped tokens) before deleting the encrypted connection; revocation failures are
reported for retry, with any rotated refresh credential retained. An expired
access token is refreshed before revocation when its refresh token is usable.
If both credentials are exhausted, only the local connection can be removed.
Removing one of multiple installation links prevents future
credential issuance for that installation; tokens already issued remain valid
until GitHub expires/revokes them or the app's repository access is removed.

## Connection-link trust boundary

The existing desktop connection flow uses a signed, short-lived install link.
It validates the issuing API, destination workspace, current workspace
access, browser nonce, and same-origin account selection. The browser nonce
does not independently authenticate the browser user to Zuse. Users must start connection
from their own Zuse app, rather than complete another person's connection link.
Protecting against forwarded-link account-linking phishing requires a separate
app-bound completion flow; this change retains the existing transport.

## Verification

Tests cover the shared connection flow, signed state, browser and origin checks,
workspace access revalidation, explicit installation selection, exact repository scoping requests, parent-token isolation,
parallel refresh, scoping denial without bot fallback, disconnect, and actual Git
author/committer attribution across repeated startup.

After deployment, authorize a test account with two selected repositories. Start
one workspace per repository. Verify each token can access its own private repo
and receives denial for the other; never print token values. Push test branches
and create draft PRs in designated test repos and verify the user is the actor.
Repeat after pause/resume and token refresh. Live OAuth and cross-repository
GitHub enforcement need this deployment smoke test.

References: [Scoped user tokens](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token),
[user authorization during installation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

## Organization members and Slack

Each organization member chooses **Connect GitHub** in Cloud settings. The member
who submits a turn supplies the GitHub identity for that turn, including commits,
pushes, and PRs. Changing the initiating member closes and resumes the provider
session with the new identity. Durable turn metadata preserves the choice across
recovery and nested agent sessions. Provider processes receive separate credential
cache directories and environment variables; Cursor uses an isolated worker because
its SDK does not expose per-agent environment configuration.

Slack turns instead use the Zuse GitHub App bot and a repository-scoped installation
token. The API seals Slack provenance into the stored message; a client cannot obtain
bot credentials by submitting a bot flag. Organization membership is checked again
before issuing a member token. Missing personal authorization fails without borrowing
another member's credentials or falling back to the bot.

This extension requires no additional database migration after `0034`. Old connections
stored under an organization ID are not assigned to a member: each member connects
their own GitHub account. Deploy API, runtime, credential helper, and UI together;
restart existing sandboxes to install the new helper and runtime. Organization and
Slack bootstrap requires runtime capability `github-execution-v1`.

Tests exercise separate real Git commits, credential-helper and `gh` invocations for
multiple members and the bot, durable actor recovery, and Cursor worker isolation.
Before rollout, also verify real pushes and draft PRs from two members and a Slack
thread in a designated test repository, including switching authors in one chat.
