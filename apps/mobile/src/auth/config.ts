/**
 * Cloud-auth configuration, read from Expo public env vars. Set these in the
 * app's `.env` / EAS secrets:
 *   EXPO_PUBLIC_WORKOS_CLIENT_ID   — the same WorkOS client the desktop uses
 *   EXPO_PUBLIC_ZUSE_RELAY_URL     — the deployed relay base URL
 */
export const WORKOS_API = "https://api.workos.com";

export const workosClientId = (): string =>
  process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? "";

export const relayBaseUrl = (): string =>
  (process.env.EXPO_PUBLIC_ZUSE_RELAY_URL ?? "https://relay.stuff.md").replace(
    /\/$/,
    "",
  );

/** App deep-link scheme (matches app.json `scheme`). */
export const APP_SCHEME = "zuse";
