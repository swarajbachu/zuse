# Mobile connection reliability

How the mobile app keeps one healthy socket per computer, and the rules that
changes must preserve.

## Rules

- **One retry owner.** The connection supervisor
  (`packages/client-runtime/src/supervisor.ts`) is the only component that
  reconnects. Mobile builds its protocol with `supervised: true`, so the Effect
  socket fails once instead of silently redialing the same URL underneath the
  supervisor.
- **Lenient liveness.** Pings go out every 5 seconds. A socket is dead only
  after 15 seconds without any decoded server frame (`WS_PING_TIMEOUT`). Large
  frames that delay a pong no longer drop a busy, healthy socket.
- **Confirm before replacing.** Mobile sets `confirmFailuresWithProbe`. A
  reported stream or request failure probes the live session
  (`connect.describe`, 5 second deadline) and only a failed probe replaces it.
  A dead socket fails the probe immediately; a stale error from an earlier
  socket is ignored. Retried commands still replace at once so they never stay
  parked on a healthy socket. Failure probes are deduplicated per session
  epoch, so an older session's pending probe cannot suppress a replacement
  session's failure or clear its active probe.
- **Definitive failures skip the probe.** An expired account grant
  (`credential-expired`) replaces the session immediately, which mints a new
  grant.
- **Stable sessions reconnect immediately.** Losing a session that lived at
  least 20 seconds reconnects without backoff and without counting a failure.
  Shorter sessions keep their backoff so a flapping route cannot spin.
- **Streams the server ends are resubscribed on the same socket** with a
  capped backoff. Failed subscriptions also resubscribe after reporting the
  failure for a health probe. A successful probe keeps the socket and the
  subscription still recovers; a fresh snapshot clears its connection error.
  A failure before the first snapshot rejects readiness without retrying.

## App lifecycle

- Sockets and local proxies stay open in the background.
- Resume after less than 10 seconds probes each session (8 second deadline).
- Resume after 10 seconds or more replaces each session at once, because
  suspended apps often lose sockets without a close event. Local proxy routes
  reopen their route instead, which reconnects through the fresh proxy in one
  step.
- A network path report only invalidates local routes when the path actually
  changed.

## Timeouts

| Step | Deadline |
| --- | --- |
| Account connect grant (`POST /connect`) | 15 s |
| Local identity check (`/pair/identity`) | 6 s |
| One connection route attempt | 12 s |
| WebSocket open | 25 s |
| Local proxy remote connect (native) | 10 s |

Both native byte proxies (phone and Mac helper) disable Nagle coalescing and
enable TCP keepalive, so small frames are not delayed and vanished peers are
noticed.

## Android local connections

`modules/local-connectivity/android` implements the same discovery and loopback
proxy contract as iOS. Android NSD browses `_zuse._tcp.`, resolves services
sequentially, and accepts only advertisements with a TLS certificate pin. Each
proxy opens TLS to the resolved computer and verifies the leaf certificate's
SHA-256 pin before forwarding any HTTP or WebSocket bytes. A Wi-Fi multicast
lock is held only while discovery is active. Network identity changes invalidate
old routes even when both networks use Wi-Fi.

This requires a native rebuild; Metro reloads cannot add the module to an older
APK. From `apps/mobile`, run `bun run android:local`. The nearby screen reports
discovery failures and offers search retry and QR pairing. QR/manual connections
must use the computer's reachable LAN address and current listening port;
`127.0.0.1` refers to the phone, and `10.0.2.2` is emulator-only.

Native verification from the generated `apps/mobile/android` project:

```sh
./gradlew :local-connectivity:testDebugUnitTest :local-connectivity:connectedDebugAndroidTest
```

The JVM tests cover concurrent proxy connections, shutdown, and failed remote
connections. The device test exercises real TLS through the loopback proxy and
rejects a certificate pin mismatch.

Linux desktops publish the same `_zuse._tcp` service and certificate pin through
the bundled `@homebridge/ciao` responder. The engine owns its lifecycle, retries
failed advertisements with backoff, and sends goodbye packets on shutdown.
AppImages do not require `avahi-publish-service` or `avahi-utils`. The responder
handles interface changes and service-name conflicts. macOS keeps its native
helper for peer-to-peer discovery.

## Effect patch

`patches/effect@4.0.0-beta.102.patch` ports the upstream pinger rule (any
frame counts as liveness, configurable `pingTimeout`). Effect 4.0.5 includes
it upstream. When upgrading Effect, drop the patch only if the new
version keeps that behavior; `test/unit/rpc-liveness-patch.test.ts` in
`packages/client-runtime` fails if the rule disappears.

## Telemetry

With analytics consent, mobile sends `connection lost` (path kind, session
lifetime, coarse reason code) and `connection restored` (downtime). Reason
codes come from `apps/mobile/src/lib/connection-telemetry.ts`; raw error
messages never leave the device.
