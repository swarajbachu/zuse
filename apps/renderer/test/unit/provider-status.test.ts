import type { AgentAvailability, ProviderId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
	availability: vi.fn(),
}));

const toast = vi.hoisted(() => ({
	add: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getRpcClient: async () => ({
		"provider.availability": rpc.availability,
	}),
}));

vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: toast,
}));

import {
	getProviderStatusNotice,
	getProviderSummary,
	isInitialProviderAvailabilityLoading,
} from "../../src/lib/provider-status.ts";
import {
	IDLE_PROVIDER_UPDATE_STATE,
	useProvidersStore,
} from "../../src/store/providers.ts";

const providers: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
	"cursor",
	"opencode",
];

const availabilityFor = (
	providerId: ProviderId,
	displayName: string,
): AgentAvailability => ({
	providerId,
	displayName,
	cliInstalled: true,
	cliLoggedIn: true,
	hasApiKey: false,
	authStatus: "authenticated",
});

describe("provider update state", () => {
	beforeEach(() => {
		useProvidersStore.setState({
			availability: [],
			loading: false,
			availabilityLoaded: false,
			error: null,
			updateStateByProvider: {},
		});
	});

	it("tracks one-click updates by provider", () => {
		useProvidersStore.getState().setProviderUpdateState("claude", {
			kind: "running",
			line: "installing Claude",
		});

		const state = useProvidersStore.getState();
		expect(state.updateStateByProvider.claude).toEqual({
			kind: "running",
			line: "installing Claude",
		});
		for (const providerId of providers.filter((p) => p !== "claude")) {
			expect(
				state.updateStateByProvider[providerId] ?? IDLE_PROVIDER_UPDATE_STATE,
			).toEqual(IDLE_PROVIDER_UPDATE_STATE);
		}
	});
});

describe("provider availability loading", () => {
	beforeEach(() => {
		rpc.availability.mockReset();
		toast.add.mockReset();
		useProvidersStore.setState({
			availability: [],
			loading: false,
			availabilityLoaded: false,
			error: null,
		});
	});

	it("shares concurrent initial loads and reuses the loaded values", async () => {
		const result = [availabilityFor("codex", "Codex")];
		rpc.availability.mockReturnValue(Effect.succeed(result));

		const store = useProvidersStore.getState();
		await Promise.all([store.load(), store.load()]);
		await useProvidersStore.getState().load();

		expect(rpc.availability).toHaveBeenCalledTimes(1);
		expect(rpc.availability).toHaveBeenCalledWith({ refresh: false });
		expect(useProvidersStore.getState().availability).toEqual(result);
	});

	it("forces a fresh server probe for an explicit refresh", async () => {
		rpc.availability.mockReturnValue(Effect.succeed([]));

		await useProvidersStore.getState().refresh();

		expect(rpc.availability).toHaveBeenCalledWith({ refresh: true });
	});

	it("notifies when the Codex app-server status probe times out", async () => {
		rpc.availability.mockReturnValue(
			Effect.succeed([
				{
					...availabilityFor("codex", "Codex"),
					cliLoggedIn: false,
					authStatus: "unknown",
					status: "warning",
					statusMessage: "timeout waiting for child process to exit",
				},
			]),
		);

		await useProvidersStore.getState().refresh();
		await useProvidersStore.getState().refresh();

		expect(toast.add).toHaveBeenCalledWith({
			id: "codex-provider-status",
			type: "error",
			priority: "high",
			timeout: 8_000,
			title: "Codex provider status",
			description: "Timed out while checking Codex app-server provider status.",
		});
		expect(toast.add).toHaveBeenCalledTimes(1);
	});

	it("only treats global loading as card loading before availability has loaded", () => {
		expect(isInitialProviderAvailabilityLoading(true, false)).toBe(true);
		expect(isInitialProviderAvailabilityLoading(true, true)).toBe(false);
		expect(isInitialProviderAvailabilityLoading(false, false)).toBe(false);
	});

	it("keeps other providers on their availability state during a post-update refresh", () => {
		const codex = availabilityFor("codex", "Codex");
		const summary = getProviderSummary(
			codex,
			true,
			isInitialProviderAvailabilityLoading(true, true),
		);

		expect(summary.statusKey).toBe("ready");
		expect(summary.headline).toBe("Authenticated");
	});

	it("still shows checking for missing provider rows during initial load", () => {
		const summary = getProviderSummary(
			undefined,
			true,
			isInitialProviderAvailabilityLoading(true, false),
		);

		expect(summary.statusKey).toBe("loading");
		expect(summary.headline).toBe("Checking…");
	});
});

describe("provider status notice", () => {
	it("does not report a healthy Codex provider", () => {
		expect(
			getProviderStatusNotice([availabilityFor("codex", "Codex")]),
		).toBeNull();
	});

	it("preserves a non-timeout Codex probe failure", () => {
		expect(
			getProviderStatusNotice([
				{
					...availabilityFor("codex", "Codex"),
					cliLoggedIn: false,
					authStatus: "unknown",
					status: "warning",
					statusMessage: "Codex app-server exited before replying.",
				},
			]),
		).toEqual({
			key: "codex-provider-status",
			title: "Codex provider status",
			description: "Codex app-server exited before replying.",
		});
	});

	it("explains a local Codex state initialization failure", () => {
		expect(
			getProviderStatusNotice([
				{
					...availabilityFor("codex", "Codex"),
					cliLoggedIn: false,
					authStatus: "unknown",
					status: "warning",
					statusMessage:
						"failed to initialize sqlite state runtime under /Users/example/.codex",
				},
			]),
		).toEqual({
			key: "codex-provider-status",
			title: "Codex provider status",
			description:
				"Codex app-server couldn't initialize local session state. Try again in a moment.",
		});
	});
});

describe("API-key-only provider summary", () => {
	it("requires an app-managed key even when the CLI is installed", () => {
		const summary = getProviderSummary(
			{
				providerId: "cursor",
				displayName: "Provider",
				cliInstalled: true,
				cliLoggedIn: false,
				hasApiKey: false,
				authStatus: "unauthenticated",
			},
			true,
			false,
		);

		expect(summary.headline).toBe("API key required");
	});

	it("reports a verified app-managed key without login copy", () => {
		const summary = getProviderSummary(
			{
				providerId: "cursor",
				displayName: "Provider",
				cliInstalled: true,
				cliLoggedIn: false,
				hasApiKey: true,
				apiKeyStatus: "verified",
				authStatus: "authenticated",
				authType: "apiKey",
			},
			true,
			false,
		);

		expect(summary).toMatchObject({
			statusKey: "ready",
			headline: "API key verified",
		});
	});

	it("surfaces a revoked saved key as an error", () => {
		const summary = getProviderSummary(
			{
				providerId: "cursor",
				displayName: "Provider",
				cliInstalled: true,
				cliLoggedIn: false,
				hasApiKey: true,
				apiKeyStatus: "invalid",
				authStatus: "unauthenticated",
				statusMessage: "The API key was rejected.",
			},
			true,
			false,
		);

		expect(summary.statusKey).toBe("error");
		expect(summary.detail).toBe("The API key was rejected.");
	});
});
