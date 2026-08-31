import {
	PRODUCTION_API_URL,
	STAGING_API_URL,
	WORKOS_PUBLIC_CLIENT_ID,
	WORKOS_STAGING_PUBLIC_CLIENT_ID,
} from "@zuse/contracts";

/**
 * Cloud-auth configuration, read from Expo public env vars. Set these in the
 * app's `.env` / EAS secrets:
 *   EXPO_PUBLIC_WORKOS_CLIENT_ID   — the same WorkOS client the desktop uses
 *   EXPO_PUBLIC_ZUSE_API_URL     — the deployed api base URL
 */
export const WORKOS_API = "https://api.workos.com";

export const defaultWorkosClientId = (development: boolean): string =>
	development ? WORKOS_STAGING_PUBLIC_CLIENT_ID : WORKOS_PUBLIC_CLIENT_ID;

export const workosClientId = (): string =>
	process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ??
	defaultWorkosClientId(typeof __DEV__ !== "undefined" && __DEV__);

export const defaultApiBaseUrl = (development: boolean): string =>
	development ? STAGING_API_URL : PRODUCTION_API_URL;

export const apiBaseUrl = (): string =>
	(
		process.env.EXPO_PUBLIC_ZUSE_API_URL ??
		defaultApiBaseUrl(typeof __DEV__ !== "undefined" && __DEV__)
	).replace(/\/$/, "");

/** App deep-link scheme (matches app.json `scheme`). */
export const APP_SCHEME = "zuse";
