import type {
	AgentAvailability,
	CloudAuthProvider,
	CloudAuthStatus,
	CloudCodexAuthMode,
	CloudProviderAuthMode,
	ProviderId,
} from "@zuse/contracts";

const BROKER_PROVIDERS = new Set<ProviderId>([
	"claude",
	"codex",
	"cursor",
	"grok",
]);

type CloudAuthenticationModes = {
	readonly codexAuthMode?: CloudCodexAuthMode;
	readonly providerAuthMode?: CloudProviderAuthMode;
};

/** Codex API keys use the general provider broker; subscription tokens use the Codex broker. */
export const cloudProviderAuthenticationMode = (
	providerId: ProviderId,
	modes: CloudAuthenticationModes | null | undefined,
): CloudProviderAuthMode | "unknown" => {
	if (!BROKER_PROVIDERS.has(providerId)) return "unknown";
	if (providerId === "codex" && modes?.codexAuthMode === "broker-v1")
		return "broker-v1";
	return (
		modes?.providerAuthMode ??
		(providerId === "codex" ? modes?.codexAuthMode : undefined) ??
		"unknown"
	);
};

/**
 * Replace native-file authentication signals with the account authority's
 * verdict for broker-backed cloud runtimes. The runtime probe still owns CLI
 * installation/version/capabilities; the authority exclusively owns whether
 * a provider credential is usable.
 */
export const applyCloudProviderAuthentication = ({
	availability,
	auth,
	codexAuthMode,
	providerAuthMode,
}: {
	readonly availability: ReadonlyArray<AgentAvailability>;
	readonly auth: CloudAuthStatus;
	readonly codexAuthMode: CloudCodexAuthMode | undefined;
	readonly providerAuthMode: CloudProviderAuthMode | undefined;
}): ReadonlyArray<AgentAvailability> => {
	const authByProvider = new Map(
		auth.providers.map((status) => [status.providerId, status] as const),
	);
	return availability.map((entry) => {
		const brokered =
			cloudProviderAuthenticationMode(entry.providerId, {
				codexAuthMode,
				providerAuthMode,
			}) === "broker-v1";
		if (!brokered) {
			return providerAuthMode === "broker-v1" &&
				!BROKER_PROVIDERS.has(entry.providerId)
				? {
						...entry,
						cliLoggedIn: false,
						hasApiKey: false,
						authStatus: "unauthenticated" as const,
						status: "disabled" as const,
						statusMessage:
							"This provider is not available through Cloud Authentication.",
					}
				: entry;
		}

		const accountStatus = authByProvider.get(
			entry.providerId as CloudAuthProvider,
		);
		if (accountStatus?.state === "connected") {
			const runtimeBlocked =
				entry.cliVersionStatus === "outdated" ||
				!(entry.runtimeAvailable ?? entry.cliInstalled);
			return {
				...entry,
				cliLoggedIn: true,
				authStatus: "authenticated" as const,
				authLabel: accountStatus.accountLabel ?? entry.authLabel,
				status: runtimeBlocked ? entry.status : ("ready" as const),
				statusMessage: runtimeBlocked ? entry.statusMessage : undefined,
			};
		}

		return {
			...entry,
			cliLoggedIn: false,
			hasApiKey: false,
			authStatus: "unauthenticated" as const,
			status:
				accountStatus?.state === "error" || accountStatus?.state === "expired"
					? ("error" as const)
					: ("warning" as const),
			statusMessage:
				accountStatus?.state === "expired"
					? "Reconnect this provider in Cloud Authentication."
					: "Connect this provider in Cloud Authentication.",
		};
	});
};
