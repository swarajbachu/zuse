# Cloud toolchain updates

The `Nightly cloud toolchain updates` workflow checks npm stable releases at
02:23 UTC every day, and supports manual dispatch for model launches. It updates
Codex, Claude Code, Bun, and Corepack together with their template/runtime pins,
the Codex contract pin, lockfile, and a new immutable toolchain version. Unchanged
versions produce no PR. Registry failures, invalid versions, downgrades, or pin
drift fail the job. Grok remains separate because its installer digest and broker
compatibility require review.

The job runs Biome, contracts/agents type checks, and the real Codex external-auth
contract test before updating one PR on `automation/cloud-toolchain`. Monitor
failed workflow notifications; a failed check must not be interpreted as an
up-to-date toolchain.

## Enable

Merge this workflow into the default branch. In repository Actions settings,
allow GitHub Actions to create pull requests. No provider credentials are needed
for detection. PR checks created by the repository token may require approval;
review their status before merging. The candidate checks also run directly in
the nightly job so they do not depend on PR-trigger behavior.

## Boat agent ownership

Boat templates preserve the provider's preinstalled agent launchers and binaries.
Zuse installs its runtime, OS dependencies, Bun, and Corepack, but does not install
Claude, Codex, or Grok on Boat. Template publication checks Claude and Codex as the
unprivileged `zuse` user and fails if either cannot run; it does not silently
replace them with Zuse's pinned versions. Other agents depend on Boat's base image
availability. Validate supported agents when publishing a new template.

E2B templates and the separate E2B authentication authority still use Zuse's
validated agent versions. Nightly pin updates apply to those installations, not
Boat's bundled agents. Workspace build/resume continues to skip agent toolchain
reconciliation. This change applies to newly published Boat templates, not
existing account images or workspaces; publish a new snapshot and rebuild images
to roll it out. Verify real turns and tools against Boat's versions before promotion.

## Rollout

Merging pins publishes the signed staging runtime through the existing cloud
runtime workflow. **It does not publish sandbox templates.** App updates alone
do not replace the CLIs installed in existing sandbox snapshots.

1. Build artifacts using `infra/cloud-sandboxes/prepare-artifacts.sh`.
2. Publish E2B staging with `node infra/cloud-sandboxes/publish-template.mjs staging`
   and Boat using `infra/cloud-sandboxes/box-publish.sh <new-version>`.
3. Set the returned immutable E2B build ID and Boat snapshot/version in staging
   API configuration (`BOAT_TEMPLATE_SNAPSHOT`, `BOAT_TEMPLATE_VERSION`), deploy,
   and rebuild a staging account image.
4. Verify a real model response and shell tool call, provider authentication,
   workspace restart, and a Slack task through completion.
5. Publish/promote production templates and signed runtime using the existing
   production release flow. Deploy matching API configuration and rebuild
   account images. Existing workspaces need a separate deliberate refresh.

A current CLI is necessary but does not guarantee a new model is available:
provider account access and Zuse's model catalog must also support it. Keep
production on tested immutable versions. Automated template promotion would
need provider credentials, an isolated live-test account, and successful smoke
tests before changing the API's template references; this nightly job only
prepares and verifies updates.
