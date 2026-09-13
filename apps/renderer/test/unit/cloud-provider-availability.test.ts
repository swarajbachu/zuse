import { type AgentAvailability, CloudAuthStatus } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { applyCloudProviderAuthentication } from "../../src/lib/cloud-provider-availability.ts";

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
