import type { AuthTokenSummary } from "@zuse/contracts";

export const deviceAccessCopy = {
	localTitle: "Browser and device access",
	pairedTitle: "Connected devices",
	remoteTitle: "Remote access",
} as const;

export const accessDeviceKind = (
	token: AuthTokenSummary,
): "browser" | "mobile" =>
	token.deviceId?.startsWith("browser_") === true ||
	token.label?.toLowerCase().includes("browser") === true
		? "browser"
		: "mobile";

export const groupPairedDeviceTokens = (
	tokens: ReadonlyArray<AuthTokenSummary>,
): {
	readonly identifiedDevices: ReadonlyArray<AuthTokenSummary>;
	readonly legacyCredentials: ReadonlyArray<AuthTokenSummary>;
} => {
	const active = tokens.filter((token) => token.revokedAt === undefined);
	return {
		identifiedDevices: active.filter((token) => token.deviceId !== undefined),
		legacyCredentials: active.filter((token) => token.deviceId === undefined),
	};
};
