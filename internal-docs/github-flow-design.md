# GitHub summary design

The PR menu uses a compact action hierarchy: View PR, Repair, Merge, Add to chat, Status, and Open in GitHub. Changes stay in the summary's top-level row. Auto Fix belongs inside Repair and in the checks header.

## Density and alignment

- Action and submenu rows: 28px height, 12px labels, 15px Hugeicons.
- Secondary status text: 11px; menu dividers: 1px with equal horizontal insets.
- Checks: 24px rows, a 240px scrolling list, and a 280px maximum popup height for a long list.
- Check status is conveyed by its icon and accessible label. The whole row opens the check URL.
- A stack summary row appears only after discovering that the current branch belongs to a stack. Stack actions in the branch menu are also hidden unless the current branch belongs to a stack. Discovery is shared and cached between both surfaces.

## Loading

Core check names, status, and links are returned with the existing PR summary request. Opening the checks preview does not wait for review bodies, avatar lookups, or workflow-job enrichment. Cached rows stay visible during refresh. The shared dotted spinner indicates pending checks. Summary counts derive from the displayed check runs, and terminal conclusions take precedence over stale running statuses.

## Browser verification

These captures use the actual renderer components with fixture PR data at 2× device scale. They are not native macOS end-to-end captures.

![PR menu and Repair submenu](assets/github-flow/repair-menu.png)

![Compact checks preview](assets/github-flow/checks-preview.png)

Verified equal row/icon sizes, submenu navigation, all 17 checks reachable by scrolling, and Auto Fix state shared between Repair and the checks header. Automated tests cover missing-stack caching, stack creation becoming visible, branch isolation, pending-probe races, and checks available before enrichment.

Summary menus are non-modal: a branch or location popup cannot put an invisible input-blocking layer over the PR trigger. Browser verification includes opening Branch, hovering PR, and opening PR in one click, plus returning from a nested Repair submenu.

## Manual repair handoff

Repair scopes and the PR menu's Add to chat action stage removable context rows above the composer. They do not send messages, change the editor text, save files, or wait for GitHub/network requests. Rows can expand to show full feedback. Repeated selections replace the same scope. The next explicit Send combines the user's message and staged context; unsuccessful delivery retains the context, and successful delivery clears only the submitted rows. Auto Fix remains the separate automatic workflow.

Browser verification exercises PR → Repair → Comments, confirms the full feedback appears in the tray without changing extra instructions, and reopens the PR menu afterward. The fixture uses the actual menu and context tray with a simple text field; submission and failure handling are covered by unit tests.
