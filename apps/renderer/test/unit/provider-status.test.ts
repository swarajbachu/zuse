import type { AgentAvailability, ProviderId } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
	availability: vi.fn(),
}));

const toast = vi.hoisted(() => ({
	add: vi.fn(),
}));

const update = vi.hoisted(() => ({
	stream: vi.fn(),
}));

vi.mock("../../src/lib/runtime-operation-client.ts", () => ({
	runtimeOperationClient: async () => ({
		"provider.update": update.stream,
	}),
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	LOCAL_ENVIRONMENT_KEY: "local",
	environmentRequiresNetwork: () => false,
	getActiveEnvironment: () => "local",
	getLocalEnvironmentId: () => "local",
}));

vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: async ({ kind, payload }: any) => ({
		result:
			kind === "provider.availability"
				? await Effect.runPromise(rpc.availability(payload))
				: undefined,
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
	providerUpdateKey,
	useProvidersStore,
} from "../../src/store/providers.ts";

const providers: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
	"cursor",
	"opencode",
	"opencode2",
	"kiro",
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
		update.stream.mockReset();
		rpc.availability.mockReset();
		rpc.availability.mockReturnValue(Effect.succeed([]));
		useProvidersStore.setState({
			availability: [],
			loading: false,
			availabilityLoaded: false,
			error: null,
			availabilityByEnvironment: {},
			updateStateByKey: {},
		});
	});
	afterEach(() => {
		useProvidersStore.setState({ availabilityByEnvironment: {} });
	});

	it("keeps a running update in the store, independent of any mounted card", async () => {
		update.stream.mockReturnValue(
			Stream.concat(
				Stream.make({ _tag: "log", text: "installing Claude" }),
				Stream.never,
			),
		);
		void useProvidersStore.getState().updateProvider("local", "claude");

		await vi.waitFor(() =>
			expect(
				useProvidersStore.getState().updateStateByKey[
					providerUpdateKey("local", "claude")
				],
			).toEqual({ kind: "running", line: "installing Claude" }),
		);
		const state = useProvidersStore.getState();
		for (const providerId of providers.filter((p) => p !== "claude")) {
			expect(
				state.updateStateByKey[providerUpdateKey("local", providerId)] ??
					IDLE_PROVIDER_UPDATE_STATE,
			).toEqual(IDLE_PROVIDER_UPDATE_STATE);
		}
		// A second request while running does not start another update.
		await useProvidersStore.getState().updateProvider("local", "claude");
		expect(update.stream).toHaveBeenCalledTimes(1);
	});

	it("re-probes availability before reporting success", async () => {
		update.stream.mockReturnValue(Stream.make({ _tag: "done", ok: true }));
		await useProvidersStore.getState().updateProvider("local", "codex");

		await vi.waitFor(() =>
			expect(
				useProvidersStore.getState().updateStateByKey[
					providerUpdateKey("local", "codex")
				],
			).toEqual({ kind: "success" }),
		);
		expect(rpc.availability).toHaveBeenCalledWith({ refresh: true });
	});

	it("reports failed updates", async () => {
		update.stream.mockReturnValue(
			Stream.make({ _tag: "done", ok: false, reason: "npm exited 1" }),
		);
		await useProvidersStore.getState().updateProvider("local", "gemini");

		expect(
			useProvidersStore.getState().updateStateByKey[
				providerUpdateKey("local", "gemini")
			],
		).toEqual({ kind: "failed", reason: "npm exited 1" });
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

describe("OpenCode managed connections", () => {
	it.each([
		"opencode",
		"opencode2",
	] as const)("does not prompt %s to log in while inventory is pending", (providerId) => {
		expect(
			getProviderSummary(
				{
					...availabilityFor(providerId, "OpenCode"),
					cliLoggedIn: false,
					authStatus: "unknown",
				},
				true,
				false,
			),
		).toMatchObject({ statusKey: "ready", actionable: false });
	});
});
