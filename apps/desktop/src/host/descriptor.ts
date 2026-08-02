import type {
	HostCapabilityId,
	HostCapabilityState,
	HostDescriptor,
	HostPlatform,
} from "@zuse/contracts";

const CAPABILITY_IDS: ReadonlyArray<HostCapabilityId> = [
	"backgroundService",
	"browserCookieImport",
	"deepEnergy",
	"nativeCredentialStore",
	"nearbyDiscovery",
	"notchTray",
	"openTargets",
	"powerTelemetry",
	"processInspection",
	"updater",
];

const capabilityStates = (
	available: ReadonlySet<HostCapabilityId>,
): Record<HostCapabilityId, HostCapabilityState> =>
	Object.fromEntries(
		CAPABILITY_IDS.map((id) => [
			id,
			available.has(id) ? "available" : "unavailable",
		]),
	) as Record<HostCapabilityId, HostCapabilityState>;

const linuxDisplayServer = (
	env: Readonly<Record<string, string | undefined>>,
): "x11" | "wayland" | null => {
	const session = env.XDG_SESSION_TYPE?.trim().toLowerCase();
	if (session === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
	if (session === "x11" || env.DISPLAY) return "x11";
	return null;
};

export const createHostDescriptor = (input: {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly packaged: boolean;
	readonly env?: Readonly<Record<string, string | undefined>>;
}): HostDescriptor => {
	const platform: HostPlatform =
		input.platform === "darwin" ||
		input.platform === "linux" ||
		input.platform === "win32"
			? input.platform
			: "linux";
	const common = new Set<HostCapabilityId>([
		"nativeCredentialStore",
		"openTargets",
		"powerTelemetry",
		"processInspection",
		"updater",
	]);
	if (platform === "darwin") {
		common.add("backgroundService");
		common.add("browserCookieImport");
		common.add("deepEnergy");
		common.add("nearbyDiscovery");
		common.add("notchTray");
	} else if (platform === "linux") {
		common.add("backgroundService");
		common.add("browserCookieImport");
		common.add("nearbyDiscovery");
	}
	return {
		platform,
		arch: input.arch,
		packaged: input.packaged,
		displayServer:
			platform === "linux" ? linuxDisplayServer(input.env ?? {}) : null,
		capabilities: capabilityStates(common),
	};
};
