import { scopedCacheKey } from "@zuse/client-runtime/environment-scope";
import { FolderId, ProviderId } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

// The coordinator now kicks off chat hydration (which wires the change
// stream) once the target connection reports connected; neither can reach a
// real connection here, so report "connected" immediately and fail the RPC.
vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return {
		...original,
		getRpcClient: async () => {
			throw new Error("no rpc in tests");
		},
		subscribeRendererRpcConnection: (
			listener: (snapshot: { status: string }) => void,
		) => {
			listener({ status: "connected" });
			return () => {};
		},
		retryRendererRpcConnection: () => {},
	};
});

import { createInitializationGate } from "../../src/lib/initialization-gate.ts";
import { getRendererClientBus } from "../../src/lib/session-timeline-client-bus.ts";
import { terminalRuntimeKey } from "../../src/lib/terminal-registry.ts";
import {
	cloudConnectionFailure,
	createConnectionAttemptCoordinator,
	type EnvironmentCatalogEntry,
	orderEnvironmentCatalog,
	projectEnvironmentShell,
	validateSshTarget,
} from "../../src/store/environment-catalog.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const entry = (
	label: string,
	profileId: string | null,
	status: EnvironmentCatalogEntry["status"],
	connectionKind: EnvironmentCatalogEntry["connectionKind"] = profileId === null
		? "local"
		: "ssh",
): EnvironmentCatalogEntry => ({
	connectionKind,
	environmentId: `env-${label}`,
	profileId,
	label,
	target: null,
	descriptor: null,
	status,
	error: null,
});

describe("environment catalog", () => {
	it("projects shell data without recursively writing to the ClientBus cell", () => {
		const overlay = vi.spyOn(getRendererClientBus(), "overlay");
		projectEnvironmentShell({
			folders: [],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		});

		expect(overlay).not.toHaveBeenCalled();
		expect(useWorkspaceStore.getState().folders).toEqual([]);
		overlay.mockRestore();
	});

	it("does not clear the landing composer draft on a shell update", () => {
		const sessions = useSessionsStore.getState();
		sessions.beginDraft({
			projectId: FolderId.make("draft-project"),
			providerId: ProviderId.make("codex"),
			model: "gpt-5",
			runtimeMode: "approval-required",
		});

		projectEnvironmentShell({
			folders: [],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		});

		expect(useSessionsStore.getState().draftSession).not.toBeNull();
		useSessionsStore.getState().clearDraft();
	});

	it("shares initialization and retries only after a failed attempt", async () => {
		const gate = createInitializationGate();
		let release: (() => void) | undefined;
		const initialize = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const first = gate(false, initialize);
		const second = gate(false, initialize);
		expect(second).toBe(first);
		expect(initialize).toHaveBeenCalledOnce();
		release?.();
		await first;

		const failure = new Error("failed");
		await expect(gate(false, async () => Promise.reject(failure))).rejects.toBe(
			failure,
		);
		const retry = vi.fn(async () => undefined);
		await gate(false, retry);
		expect(retry).toHaveBeenCalledOnce();
	});

	it("orders local, connected, then offline saved computers", () => {
		expect(
			orderEnvironmentCatalog([
				entry("Offline", "offline", "offline"),
				entry("Local", null, "connected"),
				entry("Relay", null, "connected", "relay"),
				entry("Remote", "remote", "connected"),
			]).map(({ label }) => label),
		).toEqual(["Local", "Relay", "Remote", "Offline"]);
	});

	it("replaces an in-flight connection attempt that never became ready", async () => {
		const coordinator = createConnectionAttemptCoordinator();
		let releaseFirst: (() => void) | undefined;
		let firstStillCurrent = true;
		const first = coordinator.run("relay:cloud", (isCurrent) =>
			new Promise<void>((resolve) => {
				releaseFirst = resolve;
			}).then(() => {
				firstStillCurrent = isCurrent();
			}),
		);
		const replacement = coordinator.run(
			"relay:cloud",
			async (isCurrent) => {
				expect(isCurrent()).toBe(true);
			},
			true,
		);
		expect(replacement).not.toBe(first);
		await replacement;
		releaseFirst?.();
		await first;
		expect(firstStillCurrent).toBe(false);
	});

	it("reports the failed secure-connection phase", () => {
		expect(cloudConnectionFailure(new Error("open timed out")).message).toMatch(
			/^Endpoint reachability failed:/u,
		);
		expect(
			cloudConnectionFailure(new Error("unexpected response")).message,
		).toMatch(/^WebSocket upgrade failed:/u);
		expect(
			cloudConnectionFailure(new Error("wire version mismatch")).message,
		).toMatch(/^Protocol handshake failed:/u);
	});

	it("validates manual hosts and ports", () => {
		expect(
			validateSshTarget({
				alias: "",
				hostname: "",
				username: null,
				port: null,
			}),
		).toMatch(/host name/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 70_000,
			}),
		).toMatch(/65535/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 22,
			}),
		).toBeNull();
	});

	it("keeps colliding server IDs distinct across environments", () => {
		expect(scopedCacheKey("env-a", "chat", "same-id")).not.toBe(
			scopedCacheKey("env-b", "chat", "same-id"),
		);
	});

	it("keeps colliding terminal runtime IDs distinct across environments", () => {
		expect(terminalRuntimeKey("env-a", "terminal-1")).not.toBe(
			terminalRuntimeKey("env-b", "terminal-1"),
		);
	});
});
