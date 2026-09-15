# Box and E2B deployment

Both configured adapters are advertised for new placements. Box is the default
when both are enabled; SANDBOX_DEFAULT_PROVIDER_ID can override that choice.
Explicit selections are validated against the deployment's available providers.
Retained workspaces always use their stored provider.

Production configuration enables both providers and selects the existing
zuse-base-v5 Box base snapshot. Before deploying that configuration, install
BOX_API_KEY in the production worker's secret store and verify that its Box
account can resolve zuse-base-v5. Do not copy staging account credentials into
source. If using a separate Box account, publish the reviewed base snapshot there
and set BOX_TEMPLATE_SNAPSHOT and BOX_TEMPLATE_VERSION accordingly. The base
snapshot is shared provisioning; runtime manifests and signing keys stay scoped
to each deployment.

Build and test account images on both providers before advertising availability
to users. Check create, pause/send/resume with an uploaded file, hosted ports,
local-device commands with approval, and retained E2B workspaces. Publishing code
or changing the configuration file does not deploy the worker or desktop.

Image status and build requests now accept an optional providerId. Image storage
already partitions builds by account and provider. Omitted selections preserve
the default-provider behavior for older desktop and mobile clients. Existing
API keys and agent authentication are shared across machine providers.
