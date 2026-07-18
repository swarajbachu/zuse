import type { AuthTokenSummary } from "@zuse/contracts";

export const deviceAccessCopy = {
	localTitle: "Local access",
	pairedTitle: "Paired phones",
	remoteTitle: "Remote access",
} as const;

export const groupPairedPhoneTokens = (
	tokens: ReadonlyArray<AuthTokenSummary>,
): {
	readonly identifiedPhones: ReadonlyArray<AuthTokenSummary>;
	readonly legacyCredentials: ReadonlyArray<AuthTokenSummary>;
} => {
	const active = tokens.filter((token) => token.revokedAt === undefined);
	return {
		identifiedPhones: active.filter((token) => token.deviceId !== undefined),
		legacyCredentials: active.filter((token) => token.deviceId === undefined),
	};
};
