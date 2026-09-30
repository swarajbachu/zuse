# boxd in Zuse

With **Cloud · boxd**, your Zuse agent runs in a persistent cloud workspace.
Your repository, terminal, development servers, and agent sessions live there,
so you can start a task, close your laptop, and return to the conversation later.
You can also share a preview of what you are building or fork the workspace to
try another approach on a separate machine.

This guide describes the integration in **Zuse 0.23.0**, based on source commit
`6a0c34d4` on September 30, 2026.

## Set up your workspace

1. Sign in to Zuse and activate Cloud Workspace access. Connect GitHub and your
   coding-agent credentials through the cloud onboarding flow.
2. Open **Settings → Cloud Workspace** and choose **boxd** under Machine provider.
   Select the repositories you want available and build the account image.
3. Wait for the boxd image to become ready. You can open its status to inspect
   build progress and logs. Images are provider-specific, so an existing Boat or
   E2B image does not replace this step.
4. In the composer, open **Run on** and choose **Cloud · boxd**. Select your
   repository, branch, agent, and machine size, then send your first message.

Zuse creates the workspace from your prepared image, authenticates its runtime,
prepares the repository, and starts the agent. The chat shows startup progress.
boxd is marked recommended in the image selector; availability depends on your
account access and which providers the Zuse deployment enables.

The machine sizes available through Zuse are:

| Size | CPU | Memory |
| --- | --- | --- |
| Small | 1 vCPU | 4 GB |
| Standard (configured default) | 2 vCPU | 8 GB |
| Large | 4 vCPU | 16 GB |

Your choice applies to the new workspace. If the prepared image has a different
size, Zuse resizes the machine during startup, which requires a cold reboot.

## Work with your agent

Use the same conversation workflow as other Zuse environments: send prompts,
attach files, queue follow-up messages, respond to questions and permissions,
and inspect the agent's changes. Zuse supplies the agent credentials through
its cloud authentication flow.

The cloud machine owns execution. Closing the desktop app or losing your local
connection does not cancel an accepted agent turn. When you return, Zuse opens
cached conversation history first and synchronizes with the workspace as the
connection becomes available.

The workspace's runtime stores conversations and commands. The local transcript
cache lets you read history while disconnected; it does not execute queued work
or replace the workspace's data. See the [cloud user guide](user-guide.md) for
message delivery and reconnect behavior.

## Use files, Git, terminals, and SSH

The cloud terminal runs inside the boxd workspace, alongside your agent. Use it
to run tests, install dependencies, start a development server, or inspect the
repository. Zuse's file tree and Git tools operate on that same workspace.
Workspace actions also provide SSH access.

If you use Zuse's local file sync, the cloud checkout is mirrored to your
computer. The mirror includes tracked files and eligible untracked files;
ignored dependencies and build outputs normally stay on their own machine.
It is a one-way, remote-authoritative mirror: edits to managed local files can
be overwritten by the next sync. A local terminal and the cloud terminal work
on different filesystems. See [file sync](file-sync.md) for details.

## Leave and return to a workspace

An idle boxd workspace can hibernate with its memory and processes preserved.
On an ordinary wake, Zuse reconnects to the existing runtime and agent processes.
A stopped machine, resize, crash, or runtime update can require a fresh process
start instead.

Zuse keeps track of active agent turns and explicit workspace actions. Leaving
an idle chat open, background polling, or subscription responses does not count
as continued work. Simply reading a paused conversation does not wake it;
sending a message or using workspace resources such as files, Git, terminals,
or SSH can do so.

An arbitrary background process is not an always-on service guarantee. In
particular, CPU activity alone does not keep the provider's idle timer alive.
Public preview traffic can also wake the workspace, so pausing is not a way to
make a shared URL private.

## Fork a conversation and its workspace

boxd workspaces offer two fork destinations in Zuse:

| Action | What you get | What is shared |
| --- | --- | --- |
| **Fork in new tab** | A conversation branch on the existing machine | Files, installed tools, and machine resources |
| **Fork in new machine** | A new chat and independent machine, with conversation history through the selected fork point | A copy of the source machine's state at fork time; subsequent filesystem changes are independent |

Use a new tab when you want another conversation working in the same environment.
Use a new machine when you want to explore a different implementation without
changing the original workspace's files.

A machine fork carries over files, installed dependencies, provider session
files, attachments, local commits, staged edits, and untracked files. Its new
branch starts at the captured Git HEAD. Selecting an earlier conversation point
limits the imported conversation history; it does not rewind the filesystem to
that message's timestamp.

Zuse shows a cached preview of the selected conversation while the new workspace
starts. The child receives its own workspace identity and credentials. Zuse
restarts its copied runtime and managed agents, and imports the selected history,
rather than replaying the parent's queued messages or in-flight turn. Other
machine processes retain their cloned state.

The source can briefly lose outbound connectivity while Zuse isolates the fork.
The original workspace keeps its identity and files. The source runtime must
support machine forking; older runtimes need an update. Full workspace readiness
includes preparation, history import, and reconnecting, so there is no fixed
instant-fork timing promise.

## Preview what you are building

Start your development server in the workspace, then open **Ports and previews**
in Zuse's top bar. Public URL creation and local forwarding are separate controls;
both default off and are remembered for that workspace.

- **Public URLs:** enable auto-creation to publish verified HTTP servers that
  Zuse discovers. Copy a URL to share it or open it in the preview browser.
- **Local forwarding:** enable it to reach the cloud service through a local
  SSH forward. You can use this independently of public URLs.
- **Explicit ports:** add a port yourself when needed, such as `3001`.

Zuse uses the machine's active organisation domain for public routes. A named
route can look like `https://p3000.<machine>.boxd.zuse.sh`. Each route belongs to
its machine; forking does not redirect the parent's link to the child.

Automatic discovery verifies HTTP servers and excludes the runtime's own ports.
It does not automatically publish arbitrary listeners such as SSH. Older runtimes
without server verification need an update for automatic discovery, although you
can still add a port explicitly.

Public URLs are reachable by anyone with the link. Turning public URL creation
off asks Zuse to revoke its routes and verify their removal. If removal fails,
cleanup stays pending and retries; the old link may still be reachable until it
succeeds. Turning local forwarding off releases preview-owned tunnels while
preserving tunnels needed by other Zuse features.

## Usage and current limits

Zuse records observed runtime for boxd workspaces and image builds and can send
it to Polar. This reports sampled running time, not exact provider costs.
The current integration cannot reliably settle boxd compute charges against
individual workspaces, so boxd is excluded when cloud billing enforcement is
turned on. Cloud Workspace access requirements still apply. See
[billing operations](billing.md#usage-visibility-independent-of-invoices) for
the reporting and settlement rules.

Zuse currently uses snapshots internally to prepare base templates and account
images. It does not offer a workspace snapshot browser, in-place machine rollback,
per-user custom-domain setup, or boxd organisation integration/secret management.
GitHub and agent authentication go through Zuse's existing connection flows.

## Implementation and operations

For deployment, lifecycle details, fork isolation, preview cleanup, and verification
commands, see [boxd integration operations](boxd-operations.md). The shared
[incident runbook](incident-debugging.md) covers stuck workspace diagnosis.

The main implementation references are the [provider adapter](../../packages/sandbox-providers/src/boxd.ts),
[cloud workspace API](../../infra/api/src/cloud-workspace-routes.ts),
[image selector](../../apps/renderer/src/components/settings/cloud-image-providers.tsx),
[fork destinations](../../apps/renderer/src/lib/session-fork.ts), and
[preview publication lifecycle](../../apps/renderer/src/lib/preview-publication.ts).
