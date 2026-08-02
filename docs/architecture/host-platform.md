# Host platform architecture

Zuse treats the operating system as a host capability provider, not as a UI
condition. The renderer receives one immutable `HostDescriptor` through the
preload bridge and must not infer the OS from browser globals.

## Ownership

- `packages/contracts/src/host.ts` owns the serializable platform and
  capability vocabulary.
- `apps/desktop/src/host` owns Electron-side adapters and platform factories.
- `apps/server/src/host` owns backend native-service abstractions that do not
  depend on Electron.
- The renderer may branch on a declared capability. It must not branch on
  `navigator.platform`, user-agent strings, filesystem layouts, or executable
  names.

Platform selection happens once at the composition edge. Feature code consumes
the selected adapter and keeps the same IPC and RPC contracts on every OS.

## Capability matrix

| Capability | macOS | Linux | Windows seam |
| --- | --- | --- | --- |
| Native credential store | Keychain | Secret Service | Credential Manager |
| Browser cookie import | Chromium + Keychain | Chromium + Secret Service | Explicitly unavailable |
| Open targets | Application bundles | PATH executables | Explorer only |
| Local process inspection | `lsof` | `ss`, then `/proc` | `netstat` |
| Nearby discovery | Bonjour helper | Avahi | Explicitly unavailable |
| Nearby TLS transport | Loopback proxy | Direct protected LAN listener | Explicitly unavailable |
| Notch tray | Available | Unavailable | Unavailable |
| Deep energy profiling | Available | Unavailable | Unavailable |
| Packaging | universal DMG/zip | x64 AppImage/deb | Not configured |

Unavailable means the platform factory returns an explicit capability state or
empty adapter; it must never silently run another platform's commands.

## Adding a platform feature

1. Add or reuse a capability identifier in the contracts package.
2. Define the OS-independent input, output, errors, and lifecycle in the host
   adapter.
3. Implement each supported platform and an explicit unavailable adapter for
   the others.
4. Compose the adapter in desktop or server startup.
5. Expose only serializable capability state and behavior through preload IPC
   or server RPC.
6. Gate renderer UI on capability state and test that unsupported UI is absent.
7. Add parser/factory tests that can run without the target OS.
8. Add packaging dependencies and release coverage for each supported target.

## Reliability rules

- Spawn executables without a shell and pass arguments as arrays.
- Resolve availability before presenting a native target.
- Treat missing optional host services as a reported unavailable state, not an
  application crash.
- Keep secrets in the native credential store and encrypted application data
  under mode `0600`.
- Bind nearby services only when network access is enabled; require the existing
  TLS pin and authenticated pairing flow.
- Keep macOS native helpers in macOS package resources only.
- Add a boundary test whenever a new class of platform inference is removed
  from shared or renderer code.
