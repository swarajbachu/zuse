import { type AgentAvailability, CloudAuthStatus } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	applyCloudProviderAuthentication,
	cloudProviderAuthenticationMode,
} from "../../src/lib/cloud-provider-availability.ts";

const availability = (
	providerId: AgentAvailability["providerId"],
): AgentAvailability => ({
	providerId,
	displayName: providerId,
	cliInstalled: true,
	cliLoggedIn: false,
	hasApiKey: false,
	authStatus: "unauthenticated",
	status: "warning",
});

describe("broker-backed cloud provider availability", () => {
	it("uses account authority status instead of missing sandbox auth files", () => {
		const result = applyCloudProviderAuthentication({
			availability: [availability("claude"), availability("codex")],
			auth: new CloudAuthStatus({
				authorityState: "ready",
				providers: [
					{
						providerId: "codex",
						state: "connected",
						accountLabel: "ChatGPT Plus",
					},
					{ providerId: "claude", state: "disconnected" },
				],
			}),
			codexAuthMode: "broker-v1",
			providerAuthMode: "broker-v1",
		});

		expect(result.find((entry) => entry.providerId === "codex")).toMatchObject({
			authStatus: "authenticated",
			status: "ready",
			authLabel: "ChatGPT Plus",
		});
		expect(result.find((entry) => entry.providerId === "claude")).toMatchObject(
			{
				authStatus: "unauthenticated",
				status: "warning",
			},
		);
	});

	it("disables providers that broker workspaces cannot authenticate", () => {
		const result = applyCloudProviderAuthentication({
			availability: [availability("gemini")],
			auth: new CloudAuthStatus({
				authorityState: "ready",
				providers: [],
			}),
			codexAuthMode: "broker-v1",
			providerAuthMode: "broker-v1",
		});

		expect(result[0]).toMatchObject({
			authStatus: "unauthenticated",
			status: "disabled",
		});
	});
});

it("recognizes Codex API-key authentication through the provider broker", () => {
	const result = applyCloudProviderAuthentication({
		availability: [availability("codex")],
		auth: new CloudAuthStatus({
			authorityState: "ready",
			providers: [{ providerId: "codex", state: "connected" }],
		}),
		codexAuthMode: "legacy-image",
		providerAuthMode: "broker-v1",
	});
	expect(result[0]).toMatchObject({
		authStatus: "authenticated",
		status: "ready",
	});
});

describe("cloud authentication error classification", () => {
	it.each([
		["broker-v1", "legacy-image", "broker-v1"],
		["legacy-image", "broker-v1", "broker-v1"],
		["legacy-image", "legacy-image", "legacy-image"],
		["legacy-image", undefined, "legacy-image"],
		[undefined, "broker-v1", "broker-v1"],
		[undefined, undefined, "unknown"],
	] as const)("classifies Codex mode %s with provider mode %s as %s", (codexAuthMode, providerAuthMode, expected) => {
		expect(
			cloudProviderAuthenticationMode("codex", {
				codexAuthMode,
				providerAuthMode,
			}),
		).toBe(expected);
	});
});
