import type { HostCapabilityId, HostDescriptor } from "@zuse/contracts";

const FALLBACK_HOST: HostDescriptor = {
	platform: "linux",
	arch: "unknown",
	packaged: false,
	displayServer: null,
	capabilities: {
		backgroundService: "unavailable",
		browserCookieImport: "unavailable",
		deepEnergy: "unavailable",
		nativeCredentialStore: "unavailable",
		nearbyDiscovery: "unavailable",
		notchTray: "unavailable",
		openTargets: "unavailable",
		powerTelemetry: "unavailable",
		processInspection: "unavailable",
		updater: "unavailable",
	},
};

export const hostDescriptor = (): HostDescriptor =>
	(globalThis.window?.zuse ?? globalThis.window?.memoize)?.host ??
	FALLBACK_HOST;

export const isMacHost = (): boolean => hostDescriptor().platform === "darwin";

export const hasHostCapability = (capability: HostCapabilityId): boolean =>
	hostDescriptor().capabilities[capability] === "available";
