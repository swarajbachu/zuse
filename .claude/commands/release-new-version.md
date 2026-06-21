Release a new memoize version.

Use the `release-new-version` skill from this repository.

If the user provided arguments, pass them through to `scripts/release-new-version.mjs` where appropriate:
- `major` -> `--kind=major`
- `minor` -> `--kind=minor`
- `patch` -> `--kind=patch`
- a semver version like `0.5.1` -> `--version=0.5.1`

Follow the skill workflow exactly: inspect git state, pull `origin/main`, infer or ask for the bump level, update changelog/package metadata, verify, commit, push, and create the PR.
