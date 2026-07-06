# Mobile cloud auth + discovery (PR 3 / PR 4)

Sign in once with WorkOS, and every computer linked to your account (Settings →
Devices on the Mac) shows up under **Your computers** with live presence. Tapping
one mints a short-lived, DPoP-bound connect token from the relay and opens the
session over WebSocket.

## Env vars
Set these (e.g. in `.env` for local dev, or EAS secrets):

```
EXPO_PUBLIC_WORKOS_CLIENT_ID=<the same WorkOS client the desktop uses>
EXPO_PUBLIC_ZUSE_RELAY_URL=https://relay.stuff.md
```

The redirect URI is `zuse://auth` (from `app.json` `scheme`); register it in the
WorkOS dashboard as an allowed redirect for this client.

## ⚠️ Requires a dev client (not Expo Go)
DPoP proofs are **ES256** signatures. React Native has no WebCrypto `subtle`, so
`src/polyfills.ts` installs `react-native-quick-crypto` (a native module). That
means you must build a **dev client** — Expo Go won't have the native crypto:

```
bunx expo prebuild
bunx expo run:ios     # or run:android
```

## Pieces
- `src/auth/workos.ts` — WorkOS PKCE sign-in (mirrors the desktop public-client flow).
- `src/auth/dpop.ts` — per-install ES256 device key + DPoP proof signing.
- `src/rpc/relay-client.ts` — relay HTTP client (dpop-token exchange, list, status, connect).
- `src/store/auth.ts` / `src/store/environments.ts` — auth + discovery state.
- `app/computers.tsx` — the "Your computers" screen.

## Off-network reach
Discovery + connect work on the **same Wi-Fi** today (the relay returns the
environment's LAN endpoint). Reaching a computer from cellular needs the managed
**Cloudflare tunnel**, which is deploy-time infra — see the relay deploy handoff.
Once the relay returns a tunnel `wsBaseUrl`, this client already uses it (via
`connect.endpoint.wsBaseUrl`); no mobile change needed.
