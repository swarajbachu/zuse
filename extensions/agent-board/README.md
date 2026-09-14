# Agent Board

A live status board for non-archived agent sessions across local Zuse projects.
Install from Settings → Extensions, then open **Agent Board** from the sidebar,
command palette, or workspace tabs. Search by task, project, agent, or model.

Cards show starting/running/idle/error/closed state, branch PR state, and CI check
counts. Click a task to open its existing conversation. Idle does not imply the
work is complete. Columns follow actual session state; they are not draggable.

At most three cards per column mount PR subscriptions. Pagination releases old
subscriptions, and Zuse shares subscriptions for the same workspace. A PR shared
by several sessions appears on each applicable card. This is not an index of all
repository PRs. Cloud/mobile sessions are outside this desktop preview.

Requires extension API 1.1, `ui`, `commands`, and `sessions`. The host supplies
read-only session and Git data plus explicit conversation navigation. No prompts
are submitted. Disabling the extension removes its surfaces and subscriptions.

Run `bun run test` and `bun run check-types` here. `fixtures/sessions.json` is
synthetic QA data, never a fallback for missing live sessions.
