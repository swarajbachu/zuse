import { Schema } from "effect";

export const HostPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type HostPlatform = typeof HostPlatform.Type;

export const HostCapabilityId = Schema.Literals([
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
]);
export type HostCapabilityId = typeof HostCapabilityId.Type;

export const HostCapabilityState = Schema.Literals([
	"available",
	"unavailable",
]);
export type HostCapabilityState = typeof HostCapabilityState.Type;

export const HostDescriptor = Schema.Struct({
	platform: HostPlatform,
	arch: Schema.String,
	packaged: Schema.Boolean,
	displayServer: Schema.NullOr(Schema.Literals(["x11", "wayland"])),
	capabilities: Schema.Record(HostCapabilityId, HostCapabilityState),
});
export type HostDescriptor = typeof HostDescriptor.Type;
