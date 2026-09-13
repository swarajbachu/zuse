# Zuse for Slack

Install Zuse in a Slack workspace, connect your Zuse account, and work on your
repositories through mentions and DMs. Optional automations investigate selected
alerts and return results to their threads. No slash commands are needed.

Availability depends on the integration being enabled for your environment.
If the installation page says Slack is not enabled, contact the Zuse operator.

## Customer flow

1. Visit `https://api.zuse.sh/slack/install` and authorize a Slack workspace.
2. Return to Slack. Open **Zuse → Home** or mention Zuse, then click your private
   **Connect Zuse account** button. Sign in and return to Slack after confirmation.
   No API key, agent ID, or model ID is needed. A channel-initiated connection also
   sends a success notice visible only to you. If you started with a task, that
   notice includes **Select repository** to continue the saved message and its
   attachments without sending it again. Complete sign-in within ten minutes;
   saved requests can be resumed for up to an hour, then the repository picker
   remains available for an hour. No agent starts until you confirm a repository.
3. If you have not already sent a task, invite Zuse to a channel and mention it
   with a task, or send the app a DM.
4. Choose a repository in the Slack modal. Save a personal or channel default if
   desired; the original request continues after selection. Existing threads retain
   their workspace. Repositories must already be ready cloud projects in Zuse.
   If your account has no agent/model defaults, click the private **Choose agent**
   button and select an agent/model. **Start request** continues the same task and
   attachments with the repository already selected; no separate workspace or
   resending is required. The chosen provider still needs cloud credentials in Zuse.
5. Watch the native working status give way to the actual result. @mention Zuse
   in the same thread to reuse the workspace; start a new thread for a separate
   task. Home's **My follow-up replies** setting can opt your own replies into
   continuing without another mention. This does not change teammates' behavior.

New tasks and follow-ups include only a short Slack attribution, your request,
and its attachments. When first invited into an existing conversation, Zuse also
imports earlier thread messages and images as context. That history is not
re-imported on normal follow-ups.

To configure an alert automation, open the private settings link from App Home,
then select a project, channel ID, source alert bot ID, and dry-run/live mode.
Matching alerts start cloud investigations and return results to their thread.

Each member can link their own account privately. The installer chooses one mode
in App Home: installer-only, everyone uses their own account, or the whole team uses
the installer's shared account. Sharing requires explicit confirmation and grants
access to that account's cloud repositories and usage. New installations default to
individual accounts; older installations remain installer-only. Only an account's
owner can change its defaults. Automations use the installer's linked account's
access and cloud usage. The first template recognizes Better Stack production error
and error-spike headings from the selected bot/channel; it ignores human messages,
edits, threaded updates, resolved/deployment updates, and Slack Connect events.
This is not a general-purpose workflow builder or a Slack Workflow Builder step.

## Access and limits

Automations can read only the Slack channels and files covered by the granted
permissions. The installer must retain access to the selected channel.

Start with dry-run mode, which posts a match preview without starting an agent.
Live mode starts an investigation with thread context and supported images/files,
then posts the result in the original thread. It uses your connected account's
project access and cloud usage.

Thread context is limited to the latest 500 messages and 60,000 text characters,
with up to eight supported files, each at most 20 MiB. Rate limits can delay
processing. Native loading depends on Slack support; the progress message remains
visible without it. Results include a workspace ID, not a one-click web session link.
If permissions were recently added, reauthorize the app through the installation
link. Deploying an updated backend alone does not grant those permissions.

Removing a rule does not cancel an already-running agent. Disconnect the Zuse
account from App Home to revoke new requests, use the private automation settings
page to also remove its rules, or uninstall the
app from Slack. Do not give investigation agents production deployment secrets.

Slack uses your most recent cloud workspace's agent/model configuration. If your
account has no defaults, choose the agent/model privately in Slack to continue.
This selection does not replace connecting the provider's cloud credentials in Zuse.
