Release a new Zuse version.

Use the `release-new-version` skill from this repository.

If the user provided arguments, pass them through to `scripts/release-new-version.mjs` where appropriate:
- `major` -> `--kind=major`
- `minor` -> `--kind=minor`
- `patch` -> `--kind=patch`
- a semver version like `0.5.1` -> `--version=0.5.1`

Follow the skill workflow exactly: inspect git state, inventory and classify the release evidence, write curated user-facing notes, update changelog/package metadata, verify, commit, push, merge, tag, and verify the release artifacts.
