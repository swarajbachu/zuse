# Box and E2B deployment

Both configured adapters are advertised for new placements. Box is the default
when both are enabled; SANDBOX_DEFAULT_PROVIDER_ID can override that choice.
Explicit selections are validated against the deployment's available providers.
Retained workspaces always use their stored provider.

Production configuration enables both providers and selects Box by default.
On 2026-09-15, the authorized Box key resolved zuse-base-v5 with status ready
and was installed as BOX_API_KEY on the production worker zuse-relay.
This prerequisite check and secret update did not deploy the API code or configuration.
Before enabling BOX_ADAPTER_ENABLED and selecting box as SANDBOX_DEFAULT_PROVIDER_ID, install
BOX_API_KEY in the production worker's secret store and verify that its Box
account can resolve zuse-base-v5. Do not copy staging account credentials into
source. If using a separate Box account, publish the reviewed base snapshot there
and set BOX_TEMPLATE_SNAPSHOT and BOX_TEMPLATE_VERSION accordingly. The base
snapshot is shared provisioning; runtime manifests and signing keys stay scoped
to each deployment. The production deploy script requires the Box snapshot,
version, and installed BOX_API_KEY whenever the Box adapter is enabled. Secret
presence alone does not prove snapshot access; verify it with the production
account before enabling Box.

Build and test account images on both providers before advertising availability
to users. Check create, pause/send/resume with an uploaded file, hosted ports,
local-device commands with approval, and retained E2B workspaces. Publishing code
or changing the configuration file does not deploy the worker or desktop.

Image status and build requests now accept an optional providerId. Image storage
already partitions builds by account and provider. Omitted selections preserve
the default-provider behavior for older desktop and mobile clients. Existing
API keys and agent authentication are shared across machine providers.
