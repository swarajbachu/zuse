# Faster client-to-Mac connectivity

**Status:** local-connectivity implementation landed; remote-path research deferred  
**Date:** 2026-07-21  
**Scope:** interactive client connections to a Mac, on the same network and
across the public Internet

## Accepted local-connectivity decision

The first implementation milestone is local connectivity. Remote direct-path
research remains deferred until nearby connections are reliable.

### User experience

- A phone that proves the same Zuse account or possession of the Mac's
  synchronized iCloud Keychain trust record is approved automatically.
- An unverified phone triggers a Mac approval sheet automatically. The sheet
  shows the phone label, a stable short device identifier, and a safety phrase
  that is also visible on the phone. The user compares the phrase and clicks
  **Allow** or **Deny**; nothing is typed.
- QR pairing remains the discovery fallback. It carries a one-time secret and
  Mac identity, not a permanent IP address.
- After the first approval, reconnection is automatic and never asks for a QR,
  safety phrase, or approval unless the device credential was revoked or the
  Mac identity changed.

### Wi-Fi change state machine

The environment ID and cryptographic keys identify the Mac. An IP address is a
disposable route cache only.

1. A native path monitor reports that an interface or route changed.
2. The current socket and cached endpoint are invalidated immediately.
3. The Mac republishes the same Bonjour service on its available interfaces.
4. The phone restarts discovery and resolves current LAN and Apple
   peer-to-peer candidates.
5. The phone verifies the discovered Mac key before sending its stored device
   credential.
6. The existing logical connection receives the replacement endpoint, clears
   exhausted backoff, and reconnects.

This applies when either device changes Wi-Fi, both devices change, DHCP
reassigns an address, the Mac sleeps and wakes, or the phone returns from the
background. If the devices are nearby but ordinary LAN routing is unavailable,
Network.framework may use Apple peer-to-peer Wi-Fi. If no nearby path exists,
the pairing is retained and the UI says **Looking for your Mac**.

### Security boundary

Discovery is not authorization. Device names and Bonjour metadata are
untrusted. Approval binds the exact phone public key participating in the
handshake; the matching safety phrase detects key substitution. The nearby
Network.framework path is TLS-encrypted and iOS pins the Mac's persistent
certificate before forwarding any local HTTP or WebSocket bytes. The safety
transcript and automatic-account assertion also bind that certificate pin.
Paired traffic additionally verifies the Mac's persistent Ed25519 environment
key and uses a revocable per-phone credential. Nearby requests are deduplicated
and rate-limited, the Mac handles one approval at a time, and explicit device
blocks survive desktop restarts.

The same-account path does not try grants for every environment. The Mac first
returns its environment ID and a single-use discovery nonce. The phone asks the
account service for one short-lived assertion for exactly that environment,
phone public key, nonce, and TLS certificate pin. The Mac verifies the relay
signature and all bindings before approving automatically. The assertion is
only a trust bootstrap; subsequent RPC traffic stays on the direct nearby path.

Apple does not expose a general API that lets an app read and compare the two
devices' Apple Accounts. The Apple-specific automatic path instead stores a
per-Mac 256-bit trust record in a shared Keychain Access Group with
`kSecAttrSynchronizable`; proof of possession is used without transmitting the
secret. If the record is unavailable or delayed, the app falls back silently to
the one-click Mac approval flow.

### Implemented local flow

1. The signed macOS helper publishes `_zuse._tcp` through Bonjour with Apple
   peer-to-peer enabled and forwards it to a loopback-only TLS RPC endpoint.
2. The iOS native module browses Bonjour, monitors network paths, opens a local
   loopback proxy, and validates the advertised certificate pin in its TLS
   verification callback.
3. A single discovered Mac is requested automatically. Account or synchronized
   Keychain proof produces zero-touch approval. Otherwise the Mac shows the
   phone label, cryptographic device identifier, and matching phrase with one
   **Allow** action.
4. The issued bearer credential is encrypted to the phone's persistent X25519
   key. The saved record contains stable Mac identity and certificate pins, not
   an IP address.
5. Interface changes, DHCP changes, app foregrounding, Mac wake, helper failure,
   and Bonjour republishing discard stale proxies and replace the supervisor's
   endpoint while preserving the logical environment and credential.
6. QR remains available after nearby discovery times out. Redemption now saves
   the same stable Mac identity and TLS pin, so later Bonjour recovery adopts
   the automatic secure route without pairing again.

## Executive conclusion

The cleanest long-term design is not another always-relayed tunnel. It is a
**path-racing connection layer**:

1. discover and try the Mac directly on the local network;
2. simultaneously use the existing account service as a rendezvous channel to
   exchange authenticated Internet candidates and attempt a direct encrypted
   UDP connection;
3. keep an encrypted regional relay ready as the immediate fallback; and
4. move an established logical session to a better path when one appears.

This preserves the “same Wi-Fi just works” experience while extending it to
the common remote case without forcing every byte through an intermediary.
ICE is the standardized model for exactly this: gather host, server-reflexive,
and relayed candidates, test them, and select a working pair. TURN exists for
the networks where a direct path cannot be made, and its specification advises
using the relay only when direct connectivity fails because relaying has both
provider cost and path cost ([ICE, RFC 8445](https://datatracker.ietf.org/doc/html/rfc8445),
[TURN, RFC 8656](https://datatracker.ietf.org/doc/html/rfc8656)).

For Zuse, the recommended order is:

- **Now:** make local discovery automatic with Bonjour; instrument the current
  connection phases; verify that every managed connector actually uses QUIC.
- **Next:** prototype ICE plus an end-to-end encrypted direct data channel,
  preserving the current managed tunnel as the fallback during rollout.
- **Then:** replace or supplement that fallback with latency-selected regional
  relays if measurements show the current tunnel path is the remaining tail.
- **Do not make WebTransport the first migration.** QUIC is useful once a path
  exists, but neither QUIC nor WebTransport performs NAT traversal. WebTransport
  over HTTP/3 and its browser API are also still working drafts as of this
  research ([IETF WebTransport over HTTP/3 draft](https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/),
  [W3C WebTransport Working Draft](https://www.w3.org/TR/webtransport/)).

## What the repository does today

The current remote design already separates control and data planes:

- The account relay verifies the identity account, stores linked environments,
  tracks presence, and mints short-lived DPoP-bound grants. Its own README
  explicitly excludes chat traffic from that service.
- The actual remote data path is `client -> managed edge -> cloudflared on the
  Mac -> loopback WebSocket server`.
- The mobile client first calls the account service for a connect grant, then
  opens an authenticated JSON-RPC WebSocket. It allows 25 seconds for managed
  environment opens, which suggests cold or failure cases are already material
  enough to warrant a longer timeout.
- The first environment connection currently requests a connect grant while
  adding the relay connection and requests another grant in
  `prepareOptions` immediately before opening the WebSocket. This duplicate
  control-plane POST is a concrete avoidable cost on cold connection setup.
- The relay access token is cached, but its cold path still obtains the account
  token and exchanges it for a DPoP-bound relay token before the connect grant.
- The LAN QR payload contains one IPv4 address. The mobile app has a local
  network usage description, but no declared Bonjour service types, and the
  repository contains no mDNS advertiser or browser. LAN therefore works when
  the recorded address remains correct, but it is not zero-configuration
  service discovery.
- Existing connection selection statically prefers a paired LAN record over a
  relay record for the same environment. It does not race current reachability
  or retain a working fallback while probing a better path.
- The local and remote paths expose the same WebSocket RPC protocol, so path
  selection can be changed underneath the RPC/session layer rather than
  rewriting the product protocol.

This distinction matters. Identity-provider and DPoP work can affect discovery,
token refresh, and connection establishment. It is not in the steady-state
message path. Repeated interaction lag after the socket is open is therefore
more likely to come from path length, congestion, TCP head-of-line blocking,
connector fallback, or reconnection behavior than from identity verification.
That conclusion is an inference from the repository architecture and should be
validated with phase-level measurements.

The connector's default `auto` mode already prefers QUIC and falls back to
HTTP/2 if outbound UDP is unavailable. Cloudflare documents the same behavior
and recommends QUIC for performance ([tunnel run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/),
[tunnel troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/)).
Changing the client WebSocket to a newer protocol would not remove the edge hop
or guarantee that the connector leg remains UDP.

The desktop currently resolves any `cloudflared` found on PATH or in common
Homebrew locations, verifies only that `--version` exits successfully, starts it
with `--no-autoupdate`, and does not consume its local metrics. The deployed
connector version and selected transport are consequently uncontrolled and
unobserved. Before replacing the architecture, bundle or pin a tested connector
version and record its selected protocol and edge locations.

## The Expo comparison, in plain language

Expo does not use one magical connection that is both local-fast and
works-everywhere. Its current developer workflow uses the same basic split:

- **Normal mode is local.** `npx expo start` serves the project over the local
  network by default, normally on port 8081. Expo tells users to put the phone
  and computer on the same Wi-Fi. `--localhost` restricts the address to the
  developer computer; it is mainly useful for software running on that computer,
  such as a simulator. When Expo launches Android through ADB, its CLI can also
  reverse the device port back to the computer, which makes a localhost-style
  address work over the Android device/emulator bridge; this is not a general
  physical-iPhone solution
  ([Expo Android port-reversal source](https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/platforms/android/adbReverse.ts)).
  `--tunnel` is the workaround for networks that prevent the phone from reaching
  the computer
  ([Expo CLI: server URL](https://docs.expo.dev/more/expo-cli/#server-url),
  [Expo: start developing](https://docs.expo.dev/get-started/start-developing/)).
- **The QR code is an address handoff.** Expo Go uses an `exp://` deep link such
  as `exp://192.168.x.x:8081`; opening it makes Expo Go contact the development
  server at that address. A custom development build uses its own app scheme and
  an `expo-development-client` URL containing the server URL. The CLI targets a
  development build when the project includes `expo-dev-client`, otherwise it
  targets Expo Go
  ([Expo linking URL forms](https://docs.expo.dev/versions/latest/sdk/linking/),
  [development-build workflow](https://docs.expo.dev/develop/development-builds/development-workflows/),
  [Expo CLI launch target](https://docs.expo.dev/more/expo-cli/#launch-target)).
- **The QR code is not proof of trust or a transport.** It is a convenient way
  to give the phone a URL and open the correct app. The documented development
  URL contains an IP address. The current CLI can register a development session
  with Expo's service so known client installations can list the project; that
  listing is a control-plane convenience and is skipped offline. Current source
  also contains `_expo._tcp` Bonjour advertising, but gates it behind an
  `EXPO_UNSTABLE_BONJOUR` flag, so automatic mDNS discovery is not the stable
  default
  ([development-session source](https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/server/DevelopmentSession.ts),
  [Bonjour source](https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/server/Bonjour.ts)).
- **Tunnel mode is a public reverse proxy.** The stable documented CLI path
  resolves `@expo/ngrok`, connects the local Metro port to an `exp.direct`
  public HTTPS address, and the phone uses that address. Metro's HTTP traffic
  and live WebSocket traffic therefore pass through the public proxy. Expo's
  current source also contains a separate WebSocket tunnel implementation, but
  it is selected by an explicitly unstable environment flag and should not be
  treated as the stable default. Neither the public docs nor the CLI contract
  promise a particular lower-level agent-to-edge transport
  ([current tunnel source](https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/server/AsyncNgrok.ts),
  [unstable tunnel selection](https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/server/BundlerDevServer.ts)).
  Both devices need Internet access. Expo warns that this is slower
  than a local connection because requests are forwarded through the public
  URL, that the URL can be reached by any networked device that knows it, and
  that the third-party tunnel can fail intermittently
  ([Expo CLI: tunneling and drawbacks](https://docs.expo.dev/more/expo-cli/#tunneling)).
  Expo's getting-started guide describes tunnel reloads as considerably slower
  than LAN or local connections and recommends avoiding tunnel when possible
  ([Expo device connection guidance](https://docs.expo.dev/get-started/start-developing/#open-the-app-on-your-device)).

In February 2026, an Expo maintainer further described the built-in tunnel as a
quick way around local-network limitations, without service-level guarantees
and not intended as a permanent solution
([official project issue](https://github.com/expo/expo/issues/43335#issuecomment-3921187932)).
The current documentation remains the more important source of behavior, but
the statement makes the intended role clear: fallback, not preferred path.
Expo CLI is versioned with the project's Expo package, so source-level details
and unstable flags can change by SDK release. The findings here use official
documentation current on 2026-07-20 and the current `expo/expo` main branch;
implementation work should pin citations to the exact deployed CLI version.

The useful lesson is the path order, not the particular tunnel provider. Expo
feels fast on Wi-Fi because the phone talks straight to the computer. Its tunnel
trades speed and some reliability for reachability. Zuse can preserve the same
simple QR/deep-link pairing while going further: once paired, remember a stable
device identity, rediscover its changing addresses, race direct paths, and use
the tunnel only when direct paths fail.

### What an Expo-like flow would look like here

1. The Mac shows one QR code containing the Mac's stable device ID, public key,
   a short-lived pairing secret, and account/rendezvous address—not one permanent
   IPv4 address.
2. On the same Wi-Fi, Bonjour finds current addresses automatically. The QR's
   LAN address remains a quick bootstrap candidate rather than the sole record.
3. Away from home, both devices ask the account service for permission and
   exchange possible direct addresses. They try those while a fallback path is
   already connecting.
4. The connection screen says “Direct,” “Local,” or “Relayed” in diagnostics,
   but ordinary users see only the Mac and its availability.
5. Reopening the app does not require scanning again. The device keys—not the
   old address or knowledge of a public URL—prove which devices may connect.

## Connection choices without networking jargon

No single option is fastest, available everywhere, zero-setup, and cheap to
operate. The practical design combines a fast path and a dependable fallback.

### Open a direct door to the Mac

The router can send one public port to the Mac, either through manual setup or
an automatic port-mapping protocol. This removes the relay, so remote speed can
be very good. The Port Control Protocol standard exists specifically to create
inbound mappings through a router or firewall
([PCP, RFC 6887](https://datatracker.ietf.org/doc/html/rfc6887)).

The drawbacks are substantial: not every router supports the same mechanism;
multiple routers or carrier-grade NAT can still block the path; mappings expire;
the public address can change; and a listening service becomes Internet-facing.
This should be an optional advanced candidate, never the only route. It must
expose a narrowly scoped, rate-limited, mutually authenticated TLS/QUIC endpoint,
not a LAN-oriented listener whose security assumptions have not been hardened
for arbitrary Internet traffic or a bearer token in a long-lived public URL.

### Connect directly over IPv6

When both sides have working IPv6, the Mac can have a globally routable address
without IPv4 address translation. That can give a true direct path. IPv6 was
designed to avoid the need for NAT, while still using firewall policy for
protection ([IPv6 local-network protection, RFC 4864](https://datatracker.ietf.org/doc/html/rfc4864)).

This is a valuable candidate, not a universal product answer: many client or
home networks still lack usable end-to-end IPv6, home firewalls commonly reject
unsolicited inbound connections, and temporary addresses change. Candidate
exchange, firewall handling, device authentication, and relay fallback are
still required.

### Let the two devices find a direct route automatically

This is the WebRTC/ICE-style design recommended in this note. Both devices tell
a small coordination service which addresses might work, test them safely, and
talk directly when possible. If a firewall blocks all of them, they fall back to
a relay. To the user it can feel like local Wi-Fi: choose the Mac and connect.

It offers the best balance of speed and anywhere access, but has the highest
initial engineering cost. The product must handle address changes, simultaneous
connection attempts, a fallback relay, end-to-end keys, and seamless session
recovery. WebRTC data channels package most of that machinery; ICE plus QUIC
gives more control but requires more native networking work.

### Put a small relay near the devices

A relay is a public server that both the phone and Mac can reach. It simply
passes encrypted traffic between them. Several geographic locations let the
app select a nearby server, reducing the detour compared with a poorly placed
relay. This works across restrictive networks and is much simpler than direct
connection negotiation.

It will never be as fast as a successful direct route and the operator pays for
bandwidth and long-lived connections. It is best as the guaranteed fallback.
TURN is the standardized version for UDP-oriented peer connections; an
application-level TLS/WebSocket relay is easier to fit to the current protocol
but needs care to avoid one ordered connection stalling unrelated work.

### Give every device a private network address

A mesh/VPN makes the phone and Mac look as though they share a private network.
Good implementations try a direct encrypted route and use a relay when that is
impossible. This is secure and can be quick to validate operationally.

The user may need to install or approve a VPN, and iOS/macOS integration requires
a Network Extension with additional signing, system UI, and lifecycle work.
Embedding it only for one application connection adds more product surface than
necessary. It is attractive for enterprise or expert-user deployments and less
attractive for a pair-once consumer flow.

### Keep a reverse SSH connection to a small server

The Mac can make an outbound SSH connection to a server and ask that server to
forward an incoming port back to the Mac. Remote port forwarding is a standard
part of SSH
([SSH connection protocol, RFC 4254, section 7](https://datatracker.ietf.org/doc/html/rfc4254#section-7)).
This avoids router setup and is operationally familiar.

It is still a relay, with a server hop and one long-lived TCP connection. It
needs process supervision, host-key management, public ingress protection, and
regional placement. It can be a clean self-hosted prototype or power-user
option, but it does not provide the automatic direct-route upgrade of ICE.

### Run the work on a hosted computer instead

If the repository and agent run on an Internet-hosted machine, the mobile app
connects to an ordinary hosted service. This is usually the simplest anywhere
connection and is independent of whether the user's Mac is awake.

It changes the product: code and credentials must be uploaded or cloned into a
hosted environment, local tools and files may be unavailable, compute and
storage cost move to the service, and offline/local-only work is lost. Expo's
hosted update workflow illustrates the distinction: a published update can be
opened without leaving a developer computer running, but it is not the same as
a live local development server
([Expo development workflows](https://docs.expo.dev/develop/development-builds/development-workflows/)).

### Use Apple's nearby connection features

Bonjour through Network framework is the broad, low-burden answer for finding a
Mac on the same network. For a nearby iPhone and Mac without normal Wi-Fi, the
same Network framework listener, browser, and connection can opt into Apple's
peer-to-peer Wi-Fi with `includePeerToPeer`. Apple says this mechanism works
across its device families, dates to iOS 7, and is Apple-to-Apple only
([TN3111](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview),
[TN3151](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api#Peer-to-peer-networking)).
This is the cleanest AirDrop-like nearby candidate for the current iPhone/Mac
shape. It requires a small native Expo module or helper because the current
TypeScript WebSocket layer does not expose these Network framework controls.

Multipeer Connectivity can also use peer-to-peer Wi-Fi and Bluetooth between
nearby Apple devices. Newer Wi-Fi Aware APIs can pair and communicate without
an access point on supported hardware. These can make nearby setup exceptionally
clean, including in a room without normal Wi-Fi.

They do not provide anywhere access. Multipeer sessions also disconnect when
the app backgrounds, and Wi-Fi Aware has availability, entitlement, and device
requirements. Use these as local candidate sources, with Internet direct/relay
paths underneath the same device session.

### Replace WebSocket with QUIC or WebTransport

QUIC can make a connection recover better from packet loss and network changes,
and separate streams stop one lost large response from blocking every unrelated
small response. WebTransport exposes similar capabilities to web applications.

These improve how bytes travel after a path exists. They do not find the Mac,
open a route through home routers, or remove a relay. A relayed QUIC connection
is still relayed. Use QUIC with the direct-route architecture; do not present it
as an alternative to NAT traversal.

### Use push services to wake and reconnect

Apple and Android push services are not data tunnels. They are valuable control
signals: when work changes while the mobile app is asleep, send a push; when the
app receives it or returns to the foreground, reconnect and resume from the last
event cursor. Apple permits background notifications to wake an app briefly but
states that delivery can be delayed, throttled, or omitted
([Apple background notifications](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)).
Push should improve freshness, not be required for correctness.

### Plain-language comparison

| Choice | Expected speed | Works from anywhere | User/setup burden | Safety shape | Engineering/operations |
|---|---|---|---|---|---|
| Same Wi-Fi + Bonjour | Fastest | No | One local-network permission; otherwise automatic | Safe when paired device keys authenticate after discovery | Low |
| Public port or automatic router mapping | Usually very fast | Sometimes; fails on some providers/routers | Router support or advanced setup | Highest exposure; must harden public listener | Medium implementation, high support burden |
| Direct IPv6 | Usually very fast | Only where both networks and firewalls allow it | Ideally invisible | Publicly routable address still needs strict firewall/auth | Medium |
| Automatic direct connection + relay fallback | Usually direct-fast; graceful fallback | Yes | Ideally invisible after pairing | Strong with mutual device keys and encrypted relay payloads | High initial, medium ongoing |
| Nearby regional relay | Moderate and predictable if well placed | Yes | Invisible | Strong if payload stays encrypted end to end | Medium implementation, high bandwidth/region operations |
| Mesh/VPN | Often direct-fast | Yes | VPN install/approval or bundled extension | Strong private-key network | Low with external install; high when embedded |
| Reverse SSH through a server | Moderate | Yes | Mac service plus server configuration | Strong tunnel, but public endpoint and host keys need management | Medium |
| Current managed tunnel | Moderate, sometimes variable | Yes | External connector currently required | Strong managed ingress plus app grant | Medium; current version/path observability is weak |
| Hosted work environment | Datacenter-fast to mobile | Yes | Repository/credentials move to hosted system | Centralized security and data custody | High product change and continuing compute cost |
| Multipeer / peer-to-peer Wi-Fi / Wi-Fi Aware | Very fast nearby | No | Native permission/pairing; hardware-dependent | Platform-assisted nearby security plus device auth | Medium, Apple-specific |
| QUIC/WebTransport by itself | Can improve bad-network stalls | Only if a route already exists | Invisible | Encrypted transport, still needs authorization | Medium-high; does not solve reachability |

## Mobile background behavior applies to every choice

Changing the tunnel cannot make a normal mobile app an always-running daemon.
iOS typically suspends an app after it enters the background except for limited,
purpose-specific modes
([Apple background execution modes](https://developer.apple.com/documentation/Xcode/configuring-background-execution-modes)).
Android Doze can suspend network access and defer background work
([Android Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)).
Expo's own background-task documentation likewise describes deferrable work
scheduled by the operating system, not an immediate or continuous socket, and
notes additional Expo Go limitations
([Expo BackgroundTask](https://docs.expo.dev/versions/latest/sdk/background-task/),
[Expo TaskManager](https://docs.expo.dev/versions/latest/sdk/task-manager/)).

Therefore every architecture needs:

- a stable logical session independent of any one socket;
- quick reconnect on foreground and network changes;
- idempotent command IDs so a retry cannot duplicate work;
- an event cursor/snapshot so missed messages can be recovered;
- bounded offline queues;
- user-visible push for important events and best-effort background push for
  freshness, without assuming silent pushes always arrive.

Local peer-to-peer frameworks are not an exception. Apple explicitly says
Multipeer advertising and browsing stop and sessions disconnect in the
background. A hosted backend can continue doing work while the app sleeps, but
the app still reconnects to see it.

## Recommended target architecture

```text
                           account/control service
                         (identity, devices, rendezvous)
                              /             \
                    candidates + grant   presence + candidates
                            /                 \
                       client  <----------->  Mac
                         |       direct path    |
                         |    LAN or Internet   |
                         +------> relay <-------+
                             fallback only
```

### 1. One logical connection, several candidate paths

Treat LAN, public IPv6, NAT-mapped UDP, and relay endpoints as candidates for
the same device session, not as separate user-visible connection types. Race
the likely paths and select by observed reachability and round-trip time. Keep
probing after an initial relay connection so the session can upgrade to direct,
and fall back without losing the logical session when the network changes.

ICE provides the sound base algorithm: local interface addresses are host
candidates, STUN reveals server-reflexive addresses, TURN supplies relayed
addresses, and connectivity checks determine which candidate pairs actually
work ([RFC 8445, candidate gathering](https://datatracker.ietf.org/doc/html/rfc8445#section-2.1),
[STUN, RFC 8489](https://datatracker.ietf.org/doc/html/rfc8489)). A relay-first,
upgrade-in-place strategy improves perceived availability because useful work
can begin while direct checks continue. This is an implementation policy on
top of ICE, not a reason to invent a new traversal protocol.

### 2. End-to-end device authentication

Keep the existing account identity provider for sign-in, linking, revocation,
and rendezvous authorization. Do not put it in the per-message path.

Each installation should retain a non-exportable or OS-protected device key.
The control service should issue a short-lived, audience-restricted,
single-session grant bound to that key and the target Mac. The peers then
authenticate each other while establishing the encrypted data channel. A relay
should forward ciphertext and should not need session plaintext.

The repository's existing DPoP approach is appropriate for control-plane HTTP:
DPoP binds OAuth tokens to a public key so a stolen token cannot be used without
the corresponding private key. The RFC specifically calls out installed device
applications as a useful case ([DPoP, RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449)).
DPoP itself is not an access-control system and relies on TLS for message
integrity, so the data channel still needs its own authenticated handshake and
authorization decision. Preserve one-time grant consumption and short expiry.

If QUIC 0-RTT is later enabled, only replay-safe operations may be sent as early
data. TLS 1.3 explicitly provides weaker replay protection for 0-RTT
([TLS 1.3, RFC 8446, section 8](https://datatracker.ietf.org/doc/html/rfc8446#section-8)).
Commands that mutate a repository, answer a permission request, or start work
must wait for 1-RTT or retain application-level idempotency keys.

### 3. Local discovery that feels native

Advertise a Bonjour service from the Mac and browse it from the client. The TXT
record should contain only non-secret routing metadata such as device ID,
protocol version, and supported transports. Resolve the service, connect, and
authenticate with the already-paired device key; discovery is not trust.

Bonjour combines link-local addressing, multicast DNS, and DNS service
discovery. Apple recommends Network framework for advertising, browsing, and
connecting ([TN3151](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api)).
Apple's own local-network QUIC example combines Bonjour discovery, a QUIC
`NetworkConnection`, TLS, and local identities
([Apple local-network connection example](https://developer.apple.com/documentation/visionos/connecting-ipados-and-visionos-apps-over-the-local-network)).

On Apple clients, Bonjour browsing requires the local-network usage string and
declared service types; every Bonjour register, browse, and resolve operation
is subject to local-network privacy permission
([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)).
The UI should explain the permission in terms of finding the user's Mac and
continue to offer QR/manual pairing when permission is declined.

For an Apple-only iPhone-to-Mac path that works even without a configured Wi-Fi
network, prefer Network framework's Apple peer-to-peer Wi-Fi support. Set
`includePeerToPeer` on the parameters used by the listener, browser, and
connection. Apple says this mechanism dates to iOS 7, works across iOS, iPadOS,
macOS, tvOS, and visionOS, and only interoperates between Apple devices because
its wire protocol is not public
([TN3111](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview),
[TN3151](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api#Peer-to-peer-networking)).
This is the closest supported building block to an AirDrop-like nearby path.

Multipeer Connectivity can also discover and communicate over infrastructure
Wi-Fi, peer-to-peer Wi-Fi, Bluetooth on iOS, and Ethernet on macOS, but Apple
states that advertising, browsing, and open sessions stop when the app
backgrounds
([Multipeer Connectivity](https://developer.apple.com/documentation/multipeerconnectivity)).
Network framework is a better fit for the existing client/server protocol and
avoids building the core around the Multipeer session abstraction. Wi-Fi Aware
can establish secure nearby peer-to-peer connections without an access point on
supported newer systems
([Apple Wi-Fi Aware](https://developer.apple.com/documentation/wifiaware/connecting-paired-devices));
treat it as a later candidate source, not a universal dependency.

### 4. Direct transport choices

There are two credible prototype paths:

**A. WebRTC data channels.** This is the shortest route to a standardized,
battle-tested bundle of ICE, DTLS, and a message-oriented data transport.
WebRTC data channels provide reliable and partially reliable modes over
SCTP/DTLS/ICE and include NAT traversal, confidentiality, source authentication,
and integrity ([RFC 8831](https://datatracker.ietf.org/doc/html/rfc8831)). The
tradeoff is a relatively large stack built for broader real-time communication,
plus native integration work in the React Native client.

**B. ICE plus native QUIC.** This better matches an RPC product: QUIC provides
encrypted multiplexed streams, avoids head-of-line blocking between independent
streams, and supports connection migration
([QUIC, RFC 9000](https://datatracker.ietf.org/doc/html/rfc9000)). QUIC DATAGRAM
adds non-retransmitted messages under the same security and congestion context
if a future feature needs them
([RFC 9221](https://datatracker.ietf.org/doc/html/rfc9221)). The cost is more
engineering: the ICE implementation and QUIC stack must coordinate their UDP
socket/path, and cross-platform native bindings are required.

For the current JSON-RPC behavior, reliable QUIC streams are sufficient. Use
separate streams for latency-sensitive commands/events and bulk transfers so a
lost large response does not stall unrelated work. QUIC is not expected to make
a large difference on a clean LAN; its advantage is more visible on lossy or
changing remote networks.

WebTransport should remain an adapter considered later for a browser client.
It offers multiple reliable streams and unreliable datagrams in a secure web
API, but it is client-to-server, does not supply rendezvous or hole punching,
and its specifications remain drafts. It therefore cannot replace ICE/TURN.

MASQUE is likewise complementary rather than a direct-path solution.
CONNECT-UDP standardizes proxying a UDP flow through HTTP, which can make a
UDP-based application usable through an HTTP-capable intermediary, but that
intermediary remains in the data path
([CONNECT-UDP, RFC 9298](https://datatracker.ietf.org/doc/html/rfc9298)). It is
useful as another restricted-network fallback or relay protocol, not as a way
to recover LAN-like latency.

### 5. Relay fallback and placement

TURN is the standardized fallback. It supports UDP, TCP, TLS-over-TCP, or DTLS
between client and relay so restricted networks can still connect, although
the normal relay-to-peer allocation is UDP
([RFC 8656, transports](https://datatracker.ietf.org/doc/html/rfc8656#section-3.1)).
Run or buy relays in several regions, publish more than one relay candidate,
and select by measured end-to-end candidate RTT rather than a fixed region.

For this workload, relay design rules should be:

- terminate traversal/control only; keep application payload end-to-end
  encrypted between devices;
- keep a relay route warm enough to provide immediate fallback, but move bulk
  traffic off it when direct connectivity succeeds;
- offer UDP first and TLS/TCP on port 443 for restrictive networks;
- autoscale for long-lived connections and bandwidth, not request rate alone;
- expose the selected region, transport, RTT, and direct/relayed state in
  diagnostics;
- choose locations near actual client/Mac pairs using telemetry, not only near
  the control-plane database.

A managed mesh overlay can have the same desirable shape: direct encrypted UDP
when possible, then geographically distributed or peer relays. The WireGuard
protocol supports authenticated endpoint roaming
([WireGuard protocol overview](https://www.wireguard.com/)). This is strong
validation of the architecture, but embedding an IP overlay is not necessarily
the cleanest product implementation.

On Apple platforms, a bundled IP overlay means a Network Extension packet
tunnel, entitlements, system VPN configuration, and additional lifecycle/UI.
Apple describes packet tunnel providers as VPN app extensions and documents
their deployment restrictions
([packet tunnel provider](https://developer.apple.com/documentation/networkextension/packet-tunnel-provider),
[TN3134](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)).
That is appropriate if private-network access is itself a product feature. It
is excessive if the only goal is connecting one app socket to one Mac.

## Options comparison

Ratings are architectural expectations, not measured Zuse results.

| Option | Latency | NAT/firewall success | User experience | Security model | Platform fit | Operational cost |
|---|---|---:|---|---|---|---:|
| Bonjour + current LAN socket | Best when local | Local network only | Excellent after one permission | Existing device token; discovery is untrusted | Excellent on Apple; mDNS libraries elsewhere | Low |
| ICE + direct QUIC, TURN fallback | Best available path; relay only when required | High with multi-region TURN and TCP/TLS fallback | Can be invisible and automatic | End-to-end device-authenticated QUIC | Native work on Apple, Android, and desktop | High initial; medium ongoing |
| WebRTC data channel | Near-direct; stack overhead usually secondary to path | High; ICE/TURN included | Can be invisible and automatic | DTLS peer channel plus application authorization | Mature concept, native client integration needed | Medium-high |
| Managed mesh/IP overlay | Direct when traversal works; relay otherwise | High | Extra VPN/install state unless deeply embedded | Public-key encrypted overlay | Strong OS support but Apple Network Extension complexity | Low if external; high if embedded/operated |
| Current managed tunnel | Always adds managed edge path | High where HTTPS/WebSocket works | Simple after link; external connector dependency | TLS to edge/connector plus application grant | Works with current WebSocket clients | Medium |
| Regional application or TURN relay only | Predictable if well placed, never as short as direct | High | Invisible | Must add end-to-end payload encryption | Broad | High bandwidth and global operations |
| WebTransport alone | Better stream behavior, same server path | Client-to-server only; no NAT traversal | Clean web API where available | TLS/QUIC plus application authorization | Specification and native-client gaps | Medium-high |
| Manual port forwarding | Direct after setup | Poor and router-dependent | Poor | Public ingress must be hardened | Broad | Low provider cost, high support/security cost |

## Why the current managed path may feel slow

Potential causes should be separated rather than attributed to one brand or
authentication layer:

1. **Connect control-plane time:** identity token acquisition, DPoP token
   exchange, environment grant, DNS, TLS, and WebSocket upgrade are serial
   phases in the current client.
2. **Connector cold/recovery time:** the desktop supervises an external tunnel
   process and restarts it after failure; a control-plane “online” state does
   not prove that a new data socket is immediately ready.
3. **Path stretch:** every message traverses a managed edge before reaching the
   Mac, even if the client and Mac could communicate directly.
4. **Transport fallback:** the connector can fall back from QUIC to HTTP/2 when
   UDP is blocked. The public client still uses a WebSocket, normally over TCP.
5. **Head-of-line blocking:** all RPC events share one ordered WebSocket byte
   stream, so loss or a large message can delay unrelated small messages. QUIC
   avoids blocking *between* independent QUIC streams, not within one stream
   ([RFC 9000](https://datatracker.ietf.org/doc/html/rfc9000#section-2.2)).
6. **Mobile lifecycle:** network changes and background suspension force
   reconnects. The product needs session resumption and idempotent command
   handling regardless of transport choice.

## Measurement plan before changing the data plane

Add one trace ID across the control request and socket handshake, and record:

- account access-token cache hit/miss;
- DPoP token exchange start/end;
- connect-grant start/end;
- DNS, TCP/TLS, WebSocket open, RPC handshake, and first useful response;
- connector protocol (`quic` or `http2`), edge/region identity, and connector
  restart count;
- application ping RTT and command round-trip p50/p95/p99 after connection;
- bytes and largest message per RPC stream;
- network type/change, direct versus relay, selected candidate type, and
  failover/upgrade time.

As an immediate code-path cleanup, mint only one fresh connect grant for an
attempt and pass it through to WebSocket creation. This will improve remote cold
setup independently of the later transport choice and make the remaining trace
easier to interpret.

Test the same scripted interaction on:

- same Wi-Fi, including networks with client isolation;
- different home networks with ordinary NAT;
- cellular-to-home, including carrier-grade NAT;
- enterprise/guest Wi-Fi with UDP blocked;
- IPv6-only/NAT64 client networks;
- sleep/wake, Wi-Fi-to-cellular handoff, and Mac tunnel-process restart.

The prototype should be judged on connection success, time to first useful RPC,
steady-state small-command RTT, p95/p99 stalls, reconnection time, and relay
percentage. Report these separately; one aggregate “connection latency” number
will hide the reason for regressions.

## Suggested implementation sequence

### Phase 0: establish evidence

Instrument the phases above. Surface the active path and connector transport in
diagnostics. Pin or bundle a known-current connector instead of accepting an
arbitrary PATH version with auto-update disabled. Remove the duplicate connect
grant on the initial path. Confirm whether slowness is connect-only,
steady-state, or both.

### Phase 1: zero-configuration local path

Add Bonjour advertise/browse and authenticated path racing against the stored
LAN address. Preserve QR/manual connection and the managed remote fallback.

### Phase 2: remote direct proof of concept

Prototype WebRTC data channels first if time-to-evidence matters most. Prototype
ICE plus QUIC in parallel only if the team is prepared to own native transport
integration. Reuse the existing account service for candidate exchange and
short-lived key-bound grants. Do not persist public candidates as stable device
addresses.

### Phase 3: resilient fallback

Keep the present managed tunnel during the experiment. If direct-path success is
good but fallback tails remain poor, trial at least three TURN/application relay
regions and allow candidate RTT to choose. Maintain a TLS/TCP escape path for
UDP-blocked networks.

### Phase 4: session migration

Make connection identity independent of socket identity. Add replay-safe command
IDs, resumable event cursors, bounded queues, and path upgrade/downgrade. Only
then remove the old tunnel for cohorts whose success and recovery metrics meet
the target.

## Decision

The highest-value research prototype is **Bonjour locally plus ICE direct paths
remotely, with the current tunnel retained as fallback**. For the first remote
prototype, WebRTC data channels offer the fastest way to validate NAT traversal
and latency. If the measurements justify deeper investment, move the product
data plane to ICE-selected QUIC streams for tighter control and better RPC
multiplexing.

A VPN-style overlay is a viable shortcut for internal or expert users, but it
adds system-level setup that conflicts with a “pair once and it just works”
consumer experience. WebTransport is promising for future browser support but
does not solve the core path-selection problem. A closer relay can reduce the
fallback tail; only direct path selection can recover LAN-like latency whenever
the networks permit it.
