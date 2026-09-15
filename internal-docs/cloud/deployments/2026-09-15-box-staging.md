# Box staging template rollout

Staging uses Box snapshot `zuse-base-v5` (immutable snapshot ID
`bb8b86c2-c82a-43e9-ac66-36779713fecc`). The API was deployed through the Mac
bridge at 2026-09-15T06:48:43Z, version
`b8e50183-202c-4008-a57a-685690a289a9`, confirmed at 100% traffic.
The staging Box key was installed through the same bridge. Production was not
changed. Both staging domains returned the expected unauthenticated API response.

The stock Box command environment used NVM Node 24 and installed dependencies
outside the runtime's shared dependency path. Provisioning now uses system
Node 22, explicitly installs global packages under `/usr/local`, and replaces
stock launchers owned by the shared provisioning stages. Publication checks CLI
startup as the unprivileged runtime user before saving a snapshot.

Validation passed:

- Fresh v5 live adapter lifecycle: quarantine, CLI startup, open networking,
  hosted HTTP port, file operations, pause/resume, snapshots, forks, and cleanup.
- 20 runtime asset tests and 14 deployment/provider configuration tests.
- API and sandbox-provider type checks, scoped Biome, and shell syntax checks.

All temporary builder/test boxes and the rejected v4 snapshot were removed.
Existing account images and sessions were preserved. Rebuild the Cloud account
image and start a new staging chat to test the current Box runtime. Existing E2B
sessions retain E2B. Authenticated model responses, SSH/WebSocket forwarding,
auto-sync, and the desktop performance UI still need the full user smoke journey;
the checks above do not establish those end-to-end results.
