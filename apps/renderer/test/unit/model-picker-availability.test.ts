import {
	type AgentAvailability,
	CloudAuthStatus,
	type ProviderId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	cloudSendBlocker,
	connectedCloudProviders,
	isModelPickerProviderVisible,
	selectAuthenticatedProvider,
} from "../../src/lib/model-picker-availability.ts";

const availabilityFor = (
	providerId: ProviderId,
	patch: Partial<AgentAvailability> = {},
): AgentAvailability => ({
	providerId,
	displayName: providerId,
	cliInstalled: true,
	cliLoggedIn: true,
	hasApiKey: false,
	authStatus: "authenticated",
	...patch,
});

describe("model picker provider visibility", () => {
	it("uses workspace Cloud connections rather than this computer's agents", () => {
		const connected = connectedCloudProviders(
			CloudAuthStatus.make({
				authorityState: "ready",
				providers: [
					{ providerId: "grok", state: "connected" },
					{ providerId: "claude", state: "disconnected" },
					{ providerId: "codex", state: "expired" },
					{ providerId: "cursor", state: "authorizing" },
				],
			}),
		);
		expect(connected).toEqual(["grok"]);
		for (const providerId of ["claude", "codex", "cursor"] as const) {
			expect(
				isModelPickerProviderVisible({
					providerId,
					availability: availabilityFor(providerId),
					providerEnabled: {},
					cloudProviderIds: connected,
				}),
			).toBe(false);
		}
		expect(
			isModelPickerProviderVisible({
				providerId: "grok",
				availability: undefined,
				providerEnabled: {},
				cloudProviderIds: connected,
			}),
		).toBe(true);
	});
	it("does not fall back to local agents while Cloud auth is unknown or empty", () => {
		expect(connectedCloudProviders(null)).toEqual([]);
		expect(
			isModelPickerProviderVisible({
				providerId: "claude",
				availability: availabilityFor("claude"),
				providerEnabled: {},
				cloudProviderIds: [],
			}),
		).toBe(false);
	});
	it("respects disabled providers even when connected to Cloud", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "grok",
				availability: undefined,
				providerEnabled: { grok: false },
				cloudProviderIds: ["grok"],
			}),
		).toBe(false);
	});
	it("shows installed authenticated providers", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "claude",
				availability: availabilityFor("claude"),
				providerEnabled: { claude: true },
			}),
		).toBe(true);
	});

	it("hides unauthenticated providers", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "codex",
				availability: availabilityFor("codex", {
					authStatus: "unauthenticated",
					cliLoggedIn: true,
				}),
				providerEnabled: { codex: true },
			}),
		).toBe(false);
	});

	it("shows API-key providers even when the CLI account probe is signed out", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "codex",
				availability: availabilityFor("codex", {
					authStatus: "unauthenticated",
					cliLoggedIn: false,
					hasApiKey: true,
				}),
				providerEnabled: { codex: true },
			}),
		).toBe(true);
	});

	it("does not collapse the picker before availability has loaded", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "claude",
				availability: undefined,
				providerEnabled: { claude: true },
				availabilityLoaded: false,
			}),
		).toBe(true);
	});

	it("hides missing provider rows after availability has loaded", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "claude",
				availability: undefined,
				providerEnabled: { claude: true },
				availabilityLoaded: true,
			}),
		).toBe(false);
	});

	it("does not reveal unverified cloud providers while availability loads", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "claude",
				availability: undefined,
				providerEnabled: { claude: true },
				availabilityLoaded: false,
				revealBeforeAvailabilityLoaded: false,
			}),
		).toBe(false);
	});

	it("hides providers whose CLI is not installed", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "grok",
				availability: availabilityFor("grok", {
					cliInstalled: false,
					authStatus: "authenticated",
				}),
				providerEnabled: { grok: true },
			}),
		).toBe(false);
	});

	it("hides disabled providers", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "gemini",
				availability: availabilityFor("gemini"),
				providerEnabled: { gemini: false },
			}),
		).toBe(false);
	});

	it("ignores local login signals for the API-key-only provider", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "cursor",
				availability: availabilityFor("cursor", {
					runtimeKind: "bundledSdk",
					runtimeAvailable: true,
					cliInstalled: false,
					hasApiKey: false,
					authStatus: "unknown",
					cliLoggedIn: true,
				}),
				providerEnabled: { cursor: true },
			}),
		).toBe(false);
	});

	it("shows the bundled provider with a managed key and no CLI", () => {
		expect(
			isModelPickerProviderVisible({
				providerId: "cursor",
				availability: availabilityFor("cursor", {
					runtimeKind: "bundledSdk",
					runtimeAvailable: true,
					cliInstalled: false,
					cliLoggedIn: false,
					hasApiKey: true,
					apiKeyStatus: "verified",
				}),
				providerEnabled: { cursor: true },
			}),
		).toBe(true);
	});

	it("falls back from an unauthenticated default to an authenticated provider", () => {
		expect(
			selectAuthenticatedProvider({
				preferredProviderId: "grok",
				providerIds: ["claude", "codex", "grok"],
				availability: [
					availabilityFor("grok", {
						authStatus: "unauthenticated",
						cliLoggedIn: false,
					}),
					availabilityFor("codex"),
				],
				providerEnabled: {},
			}),
		).toBe("codex");
	});
});

it("allows installed Pi with native, unverified authentication", () => {
	expect(
		isModelPickerProviderVisible({
			providerId: "pi",
			availability: availabilityFor("pi", {
				authStatus: "unknown",
				cliLoggedIn: false,
			}),
			providerEnabled: {},
		}),
	).toBe(true);
	expect(
		isModelPickerProviderVisible({
			providerId: "pi",
			availability: availabilityFor("pi", { cliInstalled: false }),
			providerEnabled: {},
		}),
	).toBe(false);
});

it("shows Zuse with a connected subscription and no installed CLI, only when enabled", () => {
	const availability = availabilityFor("zuse", {
		runtimeKind: "bundledSdk",
		runtimeAvailable: true,
		cliInstalled: false,
		cliLoggedIn: false,
		hasApiKey: false,
	});
	expect(
		isModelPickerProviderVisible({
			providerId: "zuse",
			availability,
			providerEnabled: { zuse: true },
		}),
	).toBe(true);
	expect(
		isModelPickerProviderVisible({
			providerId: "zuse",
			availability,
			providerEnabled: { zuse: false },
		}),
	).toBe(false);
	expect(
		isModelPickerProviderVisible({
			providerId: "zuse",
			availability: { ...availability, authStatus: "unauthenticated" },
			providerEnabled: { zuse: true },
		}),
	).toBe(false);
});

describe("cloud send blocker", () => {
	const connected = ["grok" as ProviderId];

	it("explains a failed sign-in check instead of silently disabling send", () => {
		expect(cloudSendBlocker("failed", [])).toBe("auth-check-failed");
		expect(cloudSendBlocker("failed", connected)).toBe("auth-check-failed");
	});

	it("asks to connect an agent when none are connected", () => {
		expect(cloudSendBlocker("ready", [])).toBe("no-connected-agents");
	});

	it("stays quiet while loading or when an agent is connected", () => {
		expect(cloudSendBlocker("loading", [])).toBeNull();
		expect(cloudSendBlocker("ready", connected)).toBeNull();
	});
});
