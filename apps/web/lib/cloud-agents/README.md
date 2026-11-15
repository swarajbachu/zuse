# Cloud coding agents data

Data for `/cloud-coding-agents`. Checked on 2026-11-15.

- `core.ts`: hand-checked rows. Every non-"unknown" value cites the page it was read from.
- `directory.json`: generated rows. Discovery came from GitHub topic search, the Agent Client
  Protocol registry, community lists and vendor homepages. For each row:
  - license, stars, creation date, last push and archived flag come from the GitHub GraphQL API;
  - macOS/Windows/Linux come from the latest GitHub release's asset names, or a README sentence;
  - feature values are "yes" only when a README or homepage sentence says so. That sentence is
    stored as `quote` next to its `src` URL. Generated rows are "no" only when the README says
    outright that the feature or platform is unsupported (the sentence is the `quote`);
  - a homepage-only row for a product that also has a repository row is merged into that row;
  - `reputation.hnStories` counts Hacker News stories whose URL points at the repo or homepage
    (hn.algolia.com, `restrictSearchableAttributes=url`, `tags=story`).
- `meta.excluded` lists candidates left out and why.

Reputation is computed at build time in `index.ts` (`reputationScore`), so the raw inputs here stay
the source of truth. To correct a row, edit `core.ts` or the row in `directory.json` and keep the
`src` URL pointing at a primary source.
