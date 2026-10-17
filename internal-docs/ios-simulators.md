# iOS simulator and Android emulator development

The desktop dock has a **Simulator** entry, and Settings has an **iOS Simulator** section.
Simulator state and native helpers belong to the selected execution environment; viewers
belong to individual chats. This implementation supports a local Mac or a connected Zuse
server running on a Mac. A Linux cloud workspace cannot run an iOS simulator; its tab says so
and does not silently switch the chat to the user's computer.

## First use

1. Open **Simulator** from the dock's launcher or `+` menu. The tab runs a read-only host
   check (Mac, Xcode, an iOS runtime, Node 22.12+ and npm) and lists the results. Nothing is
   installed or started by opening the tab.
   Unmet requirements offer a one-click fix that runs on the host Mac: **Get Xcode** opens
   the App Store; **Set up** shows the macOS administrator prompt and runs `xcode-select -s`,
   license acceptance and `xcodebuild -runFirstLaunch`; **Install** downloads the iOS runtime
   with `xcodebuild -downloadPlatform iOS` and shows its progress; **Get Node** opens the Node
   download page. `simulators.fix` is administrator-only, and the tab rechecks when the window
   regains focus.
2. Choose whether agents may use simulators (off by default) and select **Turn on simulator**.
   A blocking requirement replaces the button with **Check again**.
3. The tab shows linear progress — check, install device hub, start, find simulators, and
   agent tools when requested — derived from host state. **Cancel** turns support off.
4. Pick a simulator. Simulators are grouped by runtime, newest first; running ones lead.
   Choosing one boots it if needed and turns the tab into its viewer.

After a server restart, an enabled host is `idle`: helpers start when a Simulator tab is shown
or an agent opens a device. Settings → iOS Simulator holds the same switches, requirement
list and pinned tool versions.

## What installs, and when

| Component | Trigger | Purpose |
| --- | --- | --- |
| `expo-device-hub@0.15.3` | Enabling device support or first refresh after previously enabling it | Device discovery, native video capture, screenshots and HID input |
| `agent-device@0.21.23` | Enabling agent access or opening an agent-controlled device | Semantic UI snapshots, element references, interactions and app control |
| XCTest runner | First native iOS interaction through agent-device | Runs automation inside the simulator; initial compilation can take minutes |
| Xcode, Node and npm | Host prerequisites | Supplied by the user; Zuse checks them and does not install them |

Tools live under the environment's existing user-data directory at
`tools/<package>/<version>`. npm installs into a temporary sibling directory. The directory
becomes usable only after the entry point exists, a successful-install marker is written,
and the completed directory is renamed into place. Concurrent requests share installation
work and failed installations can be retried. No dependency is added to the mobile app.

The existing durable `@zusehq/serve` installer has a separate purpose: running a headless
Zuse server. Simulator support does not change its bootstrap or database paths.

## Android emulators

Android works on any host with the Android SDK (macOS, Linux and, for the SDK
checks, Windows). The host check finds the SDK through `ANDROID_HOME` or
`ANDROID_SDK_ROOT`, the standard Android Studio locations, then `adb` on `PATH`.
It requires Platform-Tools, the Emulator and Command-line Tools (latest), because
the hub lists AVDs with `avdmanager`. AVDs are read from the AVD home's `.ini`
files without starting a tool. On Linux the setup shows only Android rows.

| Missing | Fix button | What runs |
| --- | --- | --- |
| No SDK | **Get Android Studio** | Opens the download page on the host |
| Command-line Tools | **Install** | Downloads Google's pinned archive (`ANDROID_CMDLINE_TOOLS` in `toolchain.ts`), verifies its SHA-1, unzips into `cmdline-tools/latest`; an incomplete copy is moved aside |
| Platform-Tools or Emulator | **Install** | `sdkmanager --install platform-tools emulator`, only when the SDK license is already accepted |
| No emulator | **Create** | `sdkmanager --install system-images;android-35;google_apis;<arch>` then `avdmanager create avd` (`Zuse_Pixel_API_35`, `pixel_8`) |

Licenses are never accepted for the user. `sdkmanager` runs with stdin closed, so a
missing license fails promptly and the error says to accept it in Android Studio's
SDK Manager or with `sdkmanager --licenses`. ARM system images use a separate license.

The hub omits AVDs that have never booted, so Zuse adds them from the AVD home.
Booting goes through `POST /api/devices/boot` with the AVD name; the emulator comes
up as a serial such as `emulator-5554`, which becomes the session's device id. An
already running emulator is not booted again. Shutdown uses `/api/devices/shutdown`.

Video comes from one serve-emu WebSocket per viewer
(`/vendor/serve-emu/ws?device=<serial>&frame-meta=1`). Each binary message is an
H.264 Annex-B access unit behind a `SEMU` header: 16 bytes in v1, 24 bytes in v2
(`expo-device-hub@0.15.3` sends v2). The server converts them to packets 16
(keyframe), 17 (delta) and 18 (encoder restarted, for example after rotation). The
browser configures WebCodecs from the keyframe's SPS. The server requests a keyframe
on connect and keeps at most 30 queued frames; a slow viewer drops the backlog and
resumes at a fresh keyframe. Android has no JPEG fallback, so a window without
WebCodecs shows an error with **Reconnect**.

Input uses a separate input-only socket (`video=0`) per emulator. Touch is
normalized `down`/`move`/`up`; printable keys are sent as text, arrows and editing
keys as Android keycodes, and Escape as Back. The toolbar shows Back, Home and
Recents, and no rotation. Agents get `--platform android --serial <serial>`, the
SDK on `PATH`, and an Android quick start (`adb -s <serial> install -r <apk>`; the
host is `10.0.2.2` from the emulator).

## Viewing and controls

Each simulator has its own dock tab, named after the device. The viewer toolbar offers back
to the picker, Home, the app switcher, rotation and PNG screenshots; the overflow menu holds
agent access, settings, **Disconnect from chat** and **Shut down simulator**. Click the
screen to touch; while it is focused, typing goes to the simulator. Video uses WebCodecs with
a JPEG fallback. Frames bypass React state; decoder queues and native packet buffers are
bounded. A hidden tab or collapsed dock releases its video stream and decoder and releases
pressed keys. Input waits for native admission before sending the first gesture.

Closing a viewer tab or returning to the picker leaves the session and simulator running.
Disconnect releases chat ownership while leaving simulator power on; Shut down also powers
it off. Another chat cannot take control until the owning session closes; the picker marks
such simulators **In another chat**. Startup restores ownership without launching helpers;
sessions belonging to deleted chats are removed on discovery. Reconnect retries a failed
viewer stream without replaying input. Repeated snapshots do not reopen dismissed tabs; a new
explicit open event can.

## Agents and the development loop

Provider MCP gateways and Zuse's native model harness expose `device_list`, `device_open`,
`device_screenshot` and `device_close` through the same definitions and permission policy.
The gateway resolves the current provider session to its chat on the server.
Mutations follow the existing permission policy and are denied in plan mode. Device access
is checked again on the server and can be revoked while a provider session is alive.

`device_open` reveals the simulator in the chat's dock and returns an absolute launcher.
The launcher fixes the simulator, session, configuration and supervised daemon endpoint.
It rejects target overrides, removes ambient agent-device connection settings and rejects
closed sessions, disabled access, obsolete server incarnations and dead helpers. Each device
session gets its own loopback HTTP daemon; credentials stay in its private registration file.
Native helpers run through Zuse's existing process lease supervisor. Disabling access stops
agent daemons; disabling the hub stops capture helpers while leaving simulators running.

Build an app for the **iOS Simulator**, install it, and then use semantic snapshots:

```sh
# On the Mac, using a simulator UDID returned by device_list:
xcrun simctl install <udid> /path/to/SimulatorApp.app
xcrun simctl launch <udid> com.example.app

# Use the exact launcher returned by device_open:
<launcher> snapshot -i
<launcher> click @e3
<launcher> fill @e5 "text"
```

For this repository's mobile app, `bun run --filter mobile ios:local` builds the development
variant through the existing Expo workflow, and `bun run --filter mobile start:local` starts
Metro for a previously built development client. These commands run on the Mac that owns
the checkout and simulator. Keep that development server alive independently of viewer tabs.
A native Swift project should use its own Xcode scheme and simulator destination.

## Transport and boundaries

Streaming and screenshots use authenticated Zuse RPCs; the hub binds only to loopback and
its port is not given to the renderer. Workspace credentials can view only their chat's
sessions and can control that chat only with edit access. Host configuration and refresh
remain restricted to the environment administrator. Account/desktop connections follow the
existing host authorization boundary.

Dedicated SSH device-host configuration, cloud-chat delegation to a separate Mac, automatic
Mac checkout/build/transfer, and managed Metro tunnels are **not implemented**. Use a Mac
execution environment for this version. These require the explicit host/delegation work in
the integration plan; generic local shell access is not a simulator delegation protocol.

## Validation

The automated checks cover atomic installs and retries, live revocation, session ownership,
helper restart, bounded fragmented AVCC/JPEG parsing, screenshot limits, native input admission,
launcher isolation, plan-mode permission handling, decoder/frame disposal, and dock reveal
behavior. A supervised HTTP hub fixture exercises the real process and RPC-facing controller
without Xcode. The pinned agent package's HTTP daemon registration was also inspected at runtime.

The setup and viewer controls were exercised in Chrome using a deterministic simulator fixture.
Those screenshots do not establish native iOS capture or XCTest functionality. Before release,
verify on a Mac: npm/native helper installation, simulator boot, live video, keyboard/touch,
rotation, screenshots, a first XCTest interaction, and recovery after restarting Zuse.
