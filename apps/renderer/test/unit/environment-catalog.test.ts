import { scopedCacheKey } from "@zuse/client-runtime/environment-scope";
import type { Chat, Folder, FolderId, Message, Session } from "@zuse/contracts";
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

import { terminalRuntimeKey } from "../../src/lib/terminal-registry.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import {
	type EnvironmentCatalogEntry,
	orderEnvironmentCatalog,
	validateSshTarget,
} from "../../src/store/environment-catalog.ts";
import {
	activateEnvironmentState,
	createEnvironmentStateRegistry,
} from "../../src/store/environment-state-coordinator.ts";
import { useMessagesStore } from "../../src/store/messages.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";

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
	folders: [],
	originsByFolder: {},
	chatsByProject: {},
	sessionsByProject: {},
});

describe("environment catalog", () => {
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

	it("seeds a freshly created chat during activation and restarts chat hydration", async () => {
		const folderId = "folder-remote" as FolderId;
		const folder = { id: folderId, name: "Remote folder" } as unknown as Folder;
		const catalogEntry: EnvironmentCatalogEntry = {
			...entry("Remote", "remote", "connected"),
			folders: [folder],
		};
		const chat = {
			id: "chat-seeded",
			projectId: folderId,
			title: "Seeded",
			archivedAt: null,
		} as unknown as Chat;
		const initialSession = {
			id: "session-seeded",
			projectId: folderId,
			chatId: "chat-seeded",
		} as unknown as Session;
		const initialMessage = { id: "message-seeded" } as unknown as Message;
		const selectedFolderId = await activateEnvironmentState({
			fromEnvironmentId: "env-local",
			entry: catalogEntry,
			seed: { chat, initialSession, initialMessage },
			activateConnection: async () => undefined,
			resolveEntry: () => catalogEntry,
		});
		expect(selectedFolderId).toBe(folderId);
		expect(useChatsStore.getState().chatsByProject[folderId]?.[0]?.id).toBe(
			"chat-seeded",
		);
		expect(
			useSessionsStore.getState().sessionsByProject[folderId]?.[0]?.id,
		).toBe("session-seeded");
		expect(
			useMessagesStore.getState().messagesBySession["session-seeded"]?.[0]?.id,
		).toBe("message-seeded");
		// Stream-restart regression: the coordinator pre-populates
		// `chatsByProject`, which defeats the sidebar's lazy-hydrate guard, so
		// activation itself must kick off `hydrate` (the only path that
		// re-establishes `chat.streamChanges`) for every restored folder.
		expect(useChatsStore.getState().loadingByProject[folderId]).toBe(true);
	});

	it("restores isolated state when server IDs collide", () => {
		let state: unknown = { chatId: "same-id", environment: "local" };
		const registry = createEnvironmentStateRegistry([
			{
				getState: () => state,
				getInitialState: () => ({ chatId: null, environment: null }),
				setState: (next) => {
					state = next;
				},
			},
		]);

		registry.capture("env-local");
		state = { chatId: "same-id", environment: "remote" };
		registry.capture("env-remote");

		registry.restore("env-local");
		expect(state).toEqual({ chatId: "same-id", environment: "local" });
		registry.restore("env-remote");
		expect(state).toEqual({ chatId: "same-id", environment: "remote" });
	});
});
