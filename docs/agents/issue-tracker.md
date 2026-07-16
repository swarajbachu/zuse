# Issue tracker: GitHub

Issues and planning artifacts for this repository live in GitHub Issues. Use the `gh` CLI for all operations and infer the repository from the current checkout.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List and filter issues with `gh issue list --json ...`.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit <number> --add-label ...` or `--remove-label ...`.
- Close an issue with `gh issue close <number>`.

## Pull requests as a triage surface

External pull requests are not treated as requests by the triage workflow.

## Skill operations

- When a skill says to publish to the issue tracker, create a GitHub issue.
- When a skill says to fetch a ticket, use `gh issue view <number> --comments`.

## Wayfinding operations

The map is a GitHub issue labelled `wayfinder:map`. Its tickets are child issues linked through GitHub sub-issues.

- **Child ticket:** Create an issue with one `wayfinder:<type>` label (`research`, `prototype`, `grilling`, or `task`), then link it through GitHub's sub-issues API. If sub-issues are unavailable, add the child to a task list in the map and put `Part of #<map>` at the top of the child body.
- **Blocking:** Use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. Obtain the database ID with `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. If dependencies are unavailable, use a `Blocked by: #<number>` line in the child body.
- **Frontier:** List the map's open children in map order, then exclude assigned tickets and tickets with open blockers. The first remaining ticket is the next frontier ticket.
- **Claim:** Assign the ticket before investigation with `gh issue edit <number> --add-assignee @me`.
- **Resolve:** Post the answer as a resolution comment, close the ticket, and append a one-line gist with a link under the map's `Decisions so far` section.

GitHub reports open dependency counts through `issue_dependencies_summary.blocked_by`; a ticket is unblocked when that count is zero.
