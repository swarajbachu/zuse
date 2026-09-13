# Testing PR #572: Extensions Preview

Test the merged PR branch, not the public download. The public catalog is still empty; install the three source directories using **Settings → Extensions → Install from a directory or Git → Inspect & install**. Use the paths on the machine running Zuse. A cloud VM path will not work in your Mac app.

## Setup (5 minutes)

1. Open a disposable local Git project and create a conversation in it.
2. Enable **Settings → Extensions → Enable Extensions Preview**. Read the trusted-code notice.
3. Install `extensions/test-reports`, then `extensions/project-playbook`, then `extensions/code-follow-ups` from this checkout. Review the capabilities for each. Expect three separate installed rows, versions, statuses, and sidebar launchers.
4. Copy these fixtures into the disposable project:
   - `extensions/test-reports/fixtures/results.xml` → `reports/junit.xml`
   - `extensions/project-playbook/fixtures/procedure.md` → `docs/deploy.md`
   - `extensions/code-follow-ups/fixtures/example.txt` → `src/checkout.ts`
5. Have a second project ready with different documents and TODOs. This makes stale-workspace bugs visible.

The earlier automated desktop tests created `.context/extension-demo-project` in the checkout with these files. You can use that fixture project instead of creating another. Use a separate test profile if you want to inspect defaults without your existing settings.

## First pass: real workflows (15 minutes)

| Area | Actions | Expected result |
| --- | --- | --- |
| Test Reports | Open the sidebar tool, choose `reports/junit.xml`, read, filter failures/errors/skips, preview and select one failed test, attach. | Correct suite/test name and failure text. Only selected tests reach the composer, with source references. No tests run automatically. |
| Project Playbook | Choose `docs/deploy.md`, inspect sections, select Recovery, attach. | Correct section text and source lines. HTML is inert. Documents remain unchanged. |
| Code Follow-ups | Scan, filter a TODO/FIXME, group by file/tag, preview surrounding code, select and attach. Open it through Cmd/Ctrl+K as well. | Findings match files and lines. The command opens the same panel. Results do not include dependencies or ignored paths. |
| Attachment picker | Open the composer's **Attach from extension** action; search a tool's loaded results, preview, select, attach. | Correct source/tool identity; no duplicate or wrong result when search order changes. |
| Agent handoff | Inspect the attached text, then send one prompt asking the agent to summarize it without editing files. | The chosen agent sees the selected snapshot and references. Browsing alone does not start an agent turn. |

## Second pass: boundaries and failures (20 minutes)

| Area | Actions | Expected result |
| --- | --- | --- |
| Snapshot preservation | Attach a finding, edit or delete its original source file, then inspect/send the attachment. | Attached text still contains the original selection. Editing the source does not silently change the prompt. |
| Workspace switching | Start a scan/read, switch to the second project, reopen the tool. Repeat with a different worktree. | Old requests stop or become irrelevant; old paths/results/selections do not appear under the new workspace. |
| Cancellation | Scan a large project and click Cancel. Immediately run another scan. | Cancellation is responsive, the UI recovers, and the new scan produces its own results. |
| Large/invalid input | Try empty and malformed XML, a report with a DOCTYPE/entity, an oversized file, an empty Markdown file, and a project with no TODOs. | Explicit error/empty/truncation states; no crash or indefinite spinner. External entities are not resolved. |
| Exclusions | Add TODOs under `node_modules`, a `.gitignore`-excluded folder, and a binary file; also add an ordinary source TODO. | The ordinary finding appears; excluded/generated/binary content does not. |
| Local-only scope | Switch to a cloud or remote workspace with the tools installed locally. | Local extension panels are unavailable for that workspace; no accidental scan of the wrong machine. |

## Third pass: management and regressions (15 minutes)

- Keep all three installed. Disable one while another panel is open. The other two must remain usable; the disabled tool's commands and attachment source must disappear.
- Enable it again. Reload each local extension, remove it, then reinstall it. Check status and logs. The others must stay running, without duplicate sidebar entries or commands.
- Quit/relaunch Zuse with two tools enabled and one disabled. Enabled tools should recover; the disabled tool should remain disabled. Existing conversations and attachments should survive.
- Turn the global preview switch off and on. Confirm ordinary chat still works and extension UI cleans up/reappears once.
- Test model selection, new chat, new tab, closing a tab, ordinary file attachments, command search, sidebar project groups, and Settings navigation. These are the main merge-regression areas.
- Test a narrow window and keyboard-only operation: tab order, Enter/Space, Escape, selection, scrolling, and error readability.

For a source reload failure, use a **copy** of an extension directory, introduce a syntax error, and click Reload. The previous working version should remain usable. Undo the syntax error and reload again. Crash-loop, queue-overflow, failed persistence, migration rollback, and interrupted-generation behavior also have automated host regression tests; the three official tools do not register agent providers, so provider-session replacement guards require the provider fixture tests.

## What cannot be signed off yet

Source installation does not verify public catalog delivery. Signed catalog install/update on clean machines without Git/Bun/npm, public SDK installation, release signing credentials, and Intel Mac execution remain separate release gates. Offline catalog errors should be visible and must not uninstall existing tools.

## Reporting a failure

Include the OS, app version/commit, extension/version, project/worktree, exact steps, expected vs actual result, and a screenshot or relevant extension log. For stale-data bugs, include which project you switched from/to and whether a scan was running. Do not include credentials or private source files in a public issue.
