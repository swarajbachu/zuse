# Boat and E2B deployment

Both configured adapters are advertised for new placements. Boat is the default
when both are enabled; SANDBOX_DEFAULT_PROVIDER_ID can override that choice.
Explicit selections are validated against the deployment's available providers.
Retained workspaces always use their stored provider.

Production configuration enables both providers and selects Boat by default.
On 2026-09-15, the authorized Box key resolved zuse-base-v5 with status ready
and was installed as BOX_API_KEY on the production worker zuse-relay.
This prerequisite check and secret update did not deploy the API code or configuration.
Before enabling BOAT_ADAPTER_ENABLED and selecting box as SANDBOX_DEFAULT_PROVIDER_ID, install
BOAT_API_KEY (or retain the existing BOX_API_KEY) in the production worker's secret store and verify that its Box
account can resolve zuse-base-v5. Do not copy staging account credentials into
source. If using a separate Box account, publish the reviewed base snapshot there
and set BOAT_TEMPLATE_SNAPSHOT and BOAT_TEMPLATE_VERSION accordingly. The base
snapshot is shared provisioning; runtime manifests and signing keys stay scoped
to each deployment. The production deploy script requires the Box snapshot,
version, and installed BOAT_API_KEY or legacy BOX_API_KEY whenever the Box adapter is enabled. Secret
presence alone does not prove snapshot access; verify it with the production
account before enabling Box.

Boat must use broker authentication: the account login authority lives on E2B,
and its disk snapshots cannot seed a Boat image. Enable both enrollment and
serving gates for Codex and provider authentication, then rebuild Boat account
images so new workspaces enroll in broker mode. Existing E2B legacy images
continue to use their original authentication mode.

Build and test account images on both providers before advertising availability
to users. Check create, pause/send/resume with an uploaded file, hosted ports,
local-device commands with approval, and retained E2B workspaces. Publishing code
or changing the configuration file does not deploy the worker or desktop.

Image status and build requests now accept an optional providerId. Image storage
already partitions builds by account and provider. Omitted selections preserve
the default-provider behavior for older desktop and mobile clients. Existing
API keys and agent authentication are shared across machine providers.
