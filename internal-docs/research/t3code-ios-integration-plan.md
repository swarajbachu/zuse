# T3 Code iOS workflow and Zuse integration plan

Status: research completed; the user subsequently requested implementation. The Mac-environment
device hub, viewer, manual controls and provider MCP integration are implemented. Dedicated
SSH hosts, cloud-to-Mac delegation and automatic build/Metro workflows remain proposed.
See [implementation and validation notes](../ios-simulators.md). Reviewed 2026-10-10.

## Reference and conclusion

Full T3 Code checkout: `/home/vercel-sandbox/.zuse/reference-repos/t3code`.
Repository: https://github.com/pingdotgg/t3code.
Inspected commit: `d6f3af77192adfb2304769096eeec59d3464aa21`.
The checkout is an external, read-only implementation reference; Zuse must remain self-contained.

T3's experience combines an environment-owned device service, two separately installed tools,
an authenticated streaming proxy, four agent lifecycle tools, and per-thread viewers. Zuse
can follow this division while reusing its existing environment connections, provider MCP
infrastructure, per-chat dock, and permission policy. Adding an MCP entry alone will not
deliver the visible, reliable workflow in the screenshot.

Detailed tool installation and host lifecycle research is in
[t3code-device-toolchain.md](./t3code-device-toolchain.md).

## What the screenshot is installing

The screenshot shows **Set up devices → Agent access → Installing agent tools 0.21.12**.
That is the external `agent-device` CLI, not an iOS runtime or Zuse itself. Current T3 source
pins `agent-device@0.21.23` and `expo-device-hub@0.15.3`; these are the inspected baseline,
not a recommendation to automatically track latest.

| Component | Purpose | Installation trigger |
| --- | --- | --- |
| `expo-device-hub` | Discover devices, stream screens, support manual input | User enables device support |
| `agent-device` | Agent automation through accessibility snapshots, actions, screenshots and app control | User enables agent device access |
| iOS XCTest runner | Execute native automation on the simulator | First relevant iOS automation action; cold preparation can take minutes |
| Xcode and simulator runtime | Provide Apple's iOS simulator environment | Host prerequisite; T3 does not install Xcode |

The separate install avoids downloads, native setup and helper processes for environments
that never use devices, and permits manual viewing without granting agents control. Tools
are cached at pinned versions in the server's home rather than added to each app's
dependencies or fetched through `npx` on every invocation.
See [the pinned installer](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/server/src/device/DeviceToolchain.ts)
and [the setup UI](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/web/src/components/device/DeviceSetup.tsx).

If “only installed when zuse is needed” refers instead to Zuse's own helper, that is a
different mechanism: [runtime-installer.ts](../../apps/server/src/serve/runtime-installer.ts)
installs a durable version of `@zusehq/serve` for headless service execution;
[bundled-zuse-skill.ts](../../apps/server/src/skill/bundled-zuse-skill.ts) writes a provider
skill file. Neither supplies simulator streaming or native iOS automation.

## How the agent and panel connect

T3 exposes `device_list`, `device_open`, `device_screenshot`, and `device_close`. Opening
a device selects its host, checks agent access, boots the device if necessary, and registers
a session owned by the thread. The result returns an absolute `agent-device` launcher,
host configuration and session flags, plus a short version-specific usage guide. Subsequent
interaction uses the CLI and semantic element references rather than implementing a separate
MCP tool for every upstream command.
See [tool definitions](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/server/src/mcp/toolkits/device/tools.ts)
and [handlers and quick start](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/server/src/mcp/toolkits/device/handlers.ts).

The sidebar-like device view in the screenshot is a right panel beside the chat. A client
subscribes to environment device state and filters sessions by the active thread. New
sessions open a floating viewer by default, or a right-panel tab when floating previews
are disabled. The first snapshot establishes a baseline instead of reopening all existing
sessions. Device summaries arriving later are handled separately. Targets contain both
host ID and device ID; tab IDs encode both. Closing a view stops watching; shutdown is
an explicit device action.
See [ChatView session reconciliation, lines 5459–5530](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/web/src/components/ChatView.tsx#L5459)
and [right-panel store](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/web/src/rightPanelStore.ts).

## Streaming, input and computer use

The hub's iOS transport carries H.264 AVCC envelopes over HTTP and input over a binary
WebSocket. Android uses a different framed H.264 WebSocket protocol. T3's shared client
handles these formats, decoder support probing, credential refresh, reconnection and iOS
MJPEG fallback. It stops the transport and decoder when a viewer is hidden. Rendering is
invalidated by incoming frames rather than an always-running animation loop.
See [shared stream implementation](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/packages/client-runtime/src/device/stream.ts),
[stream tests](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/packages/client-runtime/src/device/stream.test.ts),
and [render scheduler](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/packages/client-runtime/src/device/renderScheduler.ts).

Manual pointer and keyboard input is part of the visible device viewer. Agent input is
handled through `agent-device`. This is device automation, not evidence that T3's iOS
panel supplies general Mac desktop control. Upstream `agent-device` also advertises desktop
targets, but those require a separate capability and permission review; T3's inspected
device MCP surface is explicitly iOS simulators and Android emulators.
See [upstream agent-device](https://github.com/callstack/agent-device/blob/main/README.md).

Zuse already has approval-controlled local shell execution for cloud agents in
[device-command-tools.ts](../../packages/agents/src/drivers/device-command-tools.ts)
and [cloud-client.ts](../../apps/server/src/device-bridge/cloud-client.ts). That bridge
is not a simulator viewer. Keep its execution approvals and unknown-outcome protections;
do not silently use its generic shell route as an unrestricted streaming/control channel.

## Zuse integration seams

| Concern | Existing Zuse seam | Proposed change |
| --- | --- | --- |
| Contracts and state | `packages/contracts`, environment RPC and subscriptions | Device host, platform, summary, session, state revision, typed actions and errors |
| Runtime ownership | `apps/server/src/runtime.ts`, domain handlers and transports | Environment-owned device service, host adapters, installer and supervised children |
| Agent tool exposure | `packages/agents/src/drivers`, shared MCP session kernel | Provider-neutral lifecycle tools with policy gating and image responses |
| Agent guidance | Existing provider tool instructions and session preparation | Small availability guidance; full usage returned by device open |
| Viewer protocol | `packages/client-runtime` | One reusable stream/input implementation for renderer and later mobile |
| Dock | `apps/renderer/src/store/ui.ts`, `components/right-pane.tsx`, `workspace-panel-tab.tsx` | Device tabs with host/device targets; per-chat persistence and reconciliation |
| Automatic reveal | `apps/renderer/src/lib/browser-command-client-bus.ts` | Follow environment resource subscription conventions; reveal new device sessions |
| Remote host access | Existing computer profiles and authenticated environment connections | Start with devices owned by a connected Mac environment; add dedicated SSH device hosts later |
| Settings | Existing settings and environment scopes | Separate device support and agent access; three-step compact setup with `h-7` controls |

The browser currently delegates automation to an attached renderer webview through
[BrowserBridgeService](../../apps/server/src/provider/services/browser-bridge-service.ts).
Simulator ownership must stay on its host server so an agent remains functional when the
renderer disconnects. Reuse the connections and policy, not that renderer-dependent ownership.

## Proposed delivery sequence

### 1. Host readiness and installer

- Add a read-only readiness check: host OS, resolved Node/npm versions, Xcode selection,
  usable `simctl`, installed runtimes and available simulators. Report missing runtime
  separately from missing Xcode. Check tool-specific engines rather than only “Node 22”.
- Use a single pinned tool manifest. Install separately into the existing Zuse data root,
  using a temporary sibling directory, successful-install sentinel and atomic rename.
  Serialize same-tool installation and detect incomplete installs. Preserve usable versions
  for active sessions; fail clearly if a required version cannot be downloaded.
- Supervise the hub outside the main server process: native helper failures must not crash
  conversations. Distinguish installing, starting, ready, unavailable and failed states,
  with bounded startup, cancellation and explicit retry.
- Do not move or initialize runtime databases. Any later recovery/bootstrap changes must
  follow [runtime data recovery](../cloud/runtime-data-recovery.md).

Acceptance: no network or process side effects from opening settings or inspecting readiness;
concurrent setup requests install once; interrupted setup is safely retried; existing
chat data survives enable/disable and server restart.

### 2. Manual iOS viewer

- Add compact Device hub → Simulators → Agent access onboarding. Keep manual mode useful
  when agent access is off; explain cold preparation in the status row.
- Add a Device entry to the existing right-dock launcher. Device panels must be
  multi-instance with explicit environment, chat, host and simulator identity.
- Implement authenticated streaming, touch/drag, keyboard input, rotation, screenshot and
  explicit shutdown. Prioritize a flat view; 3D models and floating previews can follow.
- Decode only while visible. Bound buffered frames, close VideoFrame objects, release
  sockets/decoders on hide, and reconnect without booting duplicate simulators.

Acceptance: local Mac viewing and manual input work; switching tabs stops hidden streams;
unsupported H.264 or insecure origins produce iOS fallback; closing a tab leaves its
simulator running; shutdown is visibly separate.

### 3. Agent verification loop

- Add the four lifecycle tools through shared provider infrastructure. Enforce environment
  access, chat ownership and plan-mode restrictions at invocation as well as discovery.
- `device_open` returns a stable absolute launcher, exact host/session/device flags and
  version-matched help. Preserve target flags across concurrent sessions. Confirm current
  provider capability-refresh behavior rather than relying on stale T3 internal docs.
- Prepare the XCTest runner on demand with progress, finite deadlines, cancellable work
  and retry that joins existing preparation rather than duplicating it.
- New server sessions reveal one dock tab in the owning chat. Baseline snapshots on
  reconnect; retain closed-tab intent; handle late summaries and duplicate events.

Acceptance: Claude, Codex and an ACP provider each list/open a device, inspect a semantic
snapshot, interact and return a screenshot; access-off is enforced; disconnecting the
renderer does not cancel the agent's device ownership; concurrent chats remain isolated.

### 4. Cloud-to-Mac workflow and build convenience

iOS simulators cannot run on this Linux workspace. A local or remote Mac with Xcode owns
the simulator and native builds. T3 supports dedicated SSH hosts, but explicitly leaves
builds, app transfer/install and Metro networking to the user/agent.
See [T3 user device documentation](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/docs/user/devices.md).

Start by routing devices through an already paired Zuse Mac environment. Define cloud
chat delegation explicitly; a cloud chat must not accidentally become a local chat just
to view a device. Then add the independent device-host adapter if it solves a remaining
workflow. Reuse SSH configuration, keys and known-host policy; no password prompts.

For a smooth iOS development loop, add a project-specific workflow that resolves the
checkout/build location, simulator destination and bundle ID, builds on the Mac, installs
the resulting simulator `.app`, starts the app and verifies a screen. For React Native,
reuse preview discovery and provide reachable Metro addressing or a managed tunnel.
Tie tunnel/process cleanup to ownership; don't terminate a shared development server.
For Swift projects, provide configurable build scheme/destination rather than assuming Expo.

For Zuse's own mobile app, validate its existing `apps/mobile` scripts and native modules
against this workflow. Do not add `agent-device` as an application runtime dependency:
[Expo's guide](https://docs.expo.dev/agents/agent-device/) confirms it operates an installed
app without an app library.

Acceptance: a cloud chat builds/installs through a configured Mac workflow, opens the
correct simulator, reaches Metro if needed, and verifies a screen after a network reconnect.
No automatic replay of actions with unknown outcomes. Multi-host IDs remain unambiguous.

## Transport and lifecycle requirements

The hub must bind loopback. Proxy only explicitly allowed routes through Zuse's authenticated
environment connection, including authenticated WebSocket upgrades and short-lived stream
tickets where headers cannot be supplied. Never proxy the hub's arbitrary shell-exec route.
Use typed server actions for device settings and read values back after mutation. Preserve
stream response behavior such as `Cache-Control: no-transform` so middleware cannot buffer
an infinite response. Keep host daemon tokens out of browser URLs and persisted UI state.
See [T3 proxy](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/server/src/device/DeviceHubProxy.ts)
and [typed actions](https://github.com/pingdotgg/t3code/blob/d6f3af77192adfb2304769096eeec59d3464aa21/apps/server/src/device/DeviceActions.ts).

Device access is separate from unrestricted agent permissions. Disabling it should block
new calls immediately, stop owned helpers, retain user settings and leave simulators running
unless shutdown was requested. Serialize mutations within a device/session; expose conflicts
between human input and concurrent agents predictably. Explicit close, shutdown, host removal,
server restart and viewer disconnect must each have documented ownership semantics.

## Validation and unresolved work

Implementation checks: applicable Biome checks, package type checks and meaningful installer,
host-service, policy, session-reconciliation and stream tests. Include interrupted npm install,
concurrent callers, native helper crash, absent Xcode/runtime, first-runner timeout, duplicate
events, credential expiry, host loss, hidden viewer, access revocation and unknown action outcomes.
Use a real Mac integration run for XCTest, native input, H.264/MJPEG and cloud-to-Mac networking;
Linux tests alone cannot prove the iOS path.

Research validation: inspected pinned source and relevant T3 tests; checked upstream primary
documentation; full clone verified. No production code changes, so type and behavior tests
do not apply to this documentation-only task. Attempted `bun run lint --
internal-docs/research/t3code-ios-integration-plan.md`; it could not run because workspace
dependencies are absent (`biome: command not found`). Markdown is outside Biome's supported
source-file checks. Local document links and pinned T3 source targets were checked separately.

Before implementation, confirm exact npm dependency trees/native artifacts and licenses for
the selected hub/control versions, minimum supported Xcode/Node versions, Zuse's chat-to-Mac
delegation contract and device ownership conflict policy. The T3 MIT license permits reuse
with its notice retained; verify third-party assets and dependencies independently if copied.
Keep the first delivery focused on flat iOS viewing and a complete agent verification loop.
