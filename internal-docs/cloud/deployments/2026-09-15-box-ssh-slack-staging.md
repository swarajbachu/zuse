# Box SSH and Slack provider fixes

Deployed through the Mac bridge to staging Worker `zuse-relay-staging`, version
`8d5fe04e-1da2-43d0-bd20-23000c9c096f`. The v5 template remains unchanged.

Box's hosted-port proxy targets a VM interface, but the runtime binds loopback.
The original SSH endpoint returned 502 despite the local runtime being healthy.
Endpoint resolution now creates interface-to-loopback TCP forwarders before
hosting the port. Existing listeners are preserved; repeated resolution reuses
them, and resolution after a cold resume recreates missing forwarders. Runtime
authentication and the SSH ticket gate remain unchanged. This also covers
loopback-bound development servers exposed through Box port forwarding.

The public API no longer inherits the latest workspace's provider when a caller
omits providerId. Shared placement chooses the currently available provider.
Agent/model defaults and idempotent recovery remain intact. Slack creates new
workspaces through this API; existing Slack threads retain their workspaces.

Validation: actual managed SSH login from the Mac to the reported workspace
succeeded as zuse; fresh Box live lifecycle passed with a loopback-bound hosted
HTTP server; 76 provider tests and 467 API tests passed. The opt-in PostgreSQL
integration test was skipped without its test database URL. API/provider type
checks and scoped Biome passed. New regression coverage checks retained E2B
provider history, binary forwarding, half-close handling, and repeated setup.

Temporary diagnostic socat processes were replaced by the implemented Node
forwarder in the reported workspace. Fresh test boxes/snapshots were cleaned up.
Production was not deployed. No template rebuild is required for these fixes.
