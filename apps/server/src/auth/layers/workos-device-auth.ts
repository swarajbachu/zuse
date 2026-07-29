import {
	type SessionBundle,
	sessionBundleFromAuthenticateResponse,
} from "./workos.ts";

const WORKOS_API = "https://api.workos.com";
const SLOW_DOWN_SECONDS = 5;

export interface DeviceAuthorizationGrant {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly verificationUriComplete: string;
	readonly expiresInSeconds: number;
	readonly intervalSeconds: number;
}

interface DeviceAuthorizationOptions {
	readonly fetcher?: typeof fetch;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly now?: () => number;
}

const expectString = (value: unknown, field: string): string => {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`WorkOS device authorization response was missing ${field}.`,
		);
	}
	return value;
};

const expectPositiveNumber = (value: unknown, field: string): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(
			`WorkOS device authorization response had invalid ${field}.`,
		);
	}
	return value;
};

const errorCode = (value: unknown): string | null => {
	if (typeof value !== "object" || value === null) return null;
	const candidate = (value as { readonly error?: unknown }).error;
	return typeof candidate === "string" ? candidate : null;
};

export const requestDeviceAuthorization = async (
	clientId: string,
	fetcher: typeof fetch = fetch,
): Promise<DeviceAuthorizationGrant> => {
	const response = await fetcher(
		`${WORKOS_API}/user_management/authorize/device`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: clientId }),
			signal: AbortSignal.timeout(15_000),
		},
	);
	const body = (await response.json()) as unknown;
	if (!response.ok) {
		throw new Error(
			`WorkOS device authorization failed (${response.status}): ${errorCode(body) ?? "unknown_error"}`,
		);
	}
	if (typeof body !== "object" || body === null) {
		throw new Error("WorkOS device authorization response was not an object.");
	}
	const value = body as Record<string, unknown>;
	return {
		deviceCode: expectString(value.device_code, "device_code"),
		userCode: expectString(value.user_code, "user_code"),
		verificationUri: expectString(value.verification_uri, "verification_uri"),
		verificationUriComplete: expectString(
			value.verification_uri_complete,
			"verification_uri_complete",
		),
		expiresInSeconds: expectPositiveNumber(value.expires_in, "expires_in"),
		intervalSeconds: expectPositiveNumber(value.interval, "interval"),
	};
};

const defaultSleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

export const pollDeviceAuthorization = async (
	clientId: string,
	grant: DeviceAuthorizationGrant,
	options: DeviceAuthorizationOptions = {},
): Promise<SessionBundle> => {
	const fetcher = options.fetcher ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const expiresAt = now() + grant.expiresInSeconds * 1_000;
	let intervalSeconds = grant.intervalSeconds;

	while (now() < expiresAt) {
		const response = await fetcher(
			`${WORKOS_API}/user_management/authenticate`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: grant.deviceCode,
				}),
				signal: AbortSignal.timeout(15_000),
			},
		);
		const body = (await response.json()) as unknown;
		if (response.ok) {
			return sessionBundleFromAuthenticateResponse(body);
		}

		const code = errorCode(body);
		if (code === "authorization_pending") {
			await sleep(intervalSeconds * 1_000);
			continue;
		}
		if (code === "slow_down") {
			intervalSeconds += SLOW_DOWN_SECONDS;
			await sleep(intervalSeconds * 1_000);
			continue;
		}
		if (code === "access_denied") {
			throw new Error("Device authorization was denied.");
		}
		if (code === "expired_token") {
			throw new Error("Device authorization expired.");
		}
		throw new Error(
			`WorkOS device authorization failed (${response.status}): ${code ?? "unknown_error"}`,
		);
	}

	throw new Error("Device authorization expired.");
};
