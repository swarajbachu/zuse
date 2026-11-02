import { Chat } from "@zuse/contracts";
import { Effect, Fiber, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appAtomRegistry } from "../../../src/store/registry";
import {
	archiveChat,
	bundlesByConnectionAtom,
	errorByConnectionAtom,
	markChatRead,
	type ProjectBundle,
	runtimeBundlesByConnectionAtom,
	setPermissionMode,
	statusBySessionAtom,
	superviseSnapshotStream,
} from "../../../src/store/sessions";

const rpc = vi.hoisted(() => ({
	archiveShouldFail: false,
	markChatReadShouldFail: false,
	permissionModeShouldFail: false,
}));

vi.mock("~/rpc/connection", () => ({
	isConnectionOnline: () => true,
	getConnectionClient: () =>
		Effect.sync(() => ({
			"chat.archive": () =>
				rpc.archiveShouldFail
					? Effect.fail(new Error("server unreachable"))
					: Effect.void,
		})),
	reportConnectionFailure: vi.fn(),
}));

vi.mock("~/rpc/actions", () => ({
	markChatRead: () =>
		rpc.markChatReadShouldFail
			? Effect.fail(new Error("offline"))
			: Effect.sync(() => serverChat),
	renameChat: () => Effect.void,
	setSessionPermissionMode: () =>
		rpc.permissionModeShouldFail
			? Effect.fail(new Error("mode rejected"))
			: Effect.void,
	setSessionRuntimeMode: () => Effect.void,
}));

vi.mock("~/offline/cache", () => ({
	readSessionsSnapshot: () => Effect.sync(() => null),
	writeSessionsSnapshot: () => Effect.void,
}));

vi.mock("~/store/messages", async () => {
	const { Atom } = await import("effect/unstable/reactivity");
	return {
		messagesBySessionAtom: Atom.make({}).pipe(Atom.keepAlive),
	};
});

const options = { host: "127.0.0.1", port: 4000, token: null } as never;

const makeChat = (overrides: Record<string, unknown> = {}) =>
	({
		id: "chat-1",
		projectId: "project-1",
		title: "Chat",
		activeSessionId: "session-1",
		updatedAt: new Date("2026-07-01"),
		lastMessageAt: new Date("2026-07-01"),
		lastReadAt: new Date("2026-06-01"),
		...overrides,
	}) as never;

const makeSession = (overrides: Record<string, unknown> = {}) =>
	({
		id: "session-1",
		chatId: "chat-1",
		projectId: "project-1",
		title: "Thread",
		providerId: "codex",
		model: "gpt-5.5",
		status: "idle",
		permissionMode: "default",
		runtimeMode: "approval-required",
		...overrides,
	}) as never;

const serverChat = makeChat({ lastReadAt: new Date("2026-07-02") });

const seedBundles = () => {
	const bundle: ProjectBundle = {
		project: { id: "project-1", name: "Project", path: "/tmp/p" } as never,
		chats: [makeChat()],
		sessions: [makeSession()],
	};
	appAtomRegistry.set(runtimeBundlesByConnectionAtom, { conn: [bundle] });
};

describe("sessions atom actions", () => {
	beforeEach(() => {
		rpc.archiveShouldFail = false;
		rpc.markChatReadShouldFail = false;
		rpc.permissionModeShouldFail = false;
		appAtomRegistry.set(runtimeBundlesByConnectionAtom, {});
		appAtomRegistry.set(statusBySessionAtom, {});
		appAtomRegistry.set(errorByConnectionAtom, {});
		seedBundles();
	});

	it("archiveChat removes optimistically and keeps removal on success", async () => {
		await archiveChat("conn", options, "chat-1" as never);
		const bundles = appAtomRegistry.get(bundlesByConnectionAtom).conn ?? [];
		expect(bundles[0]?.chats).toHaveLength(0);
		expect(bundles[0]?.sessions).toHaveLength(0);
		expect(appAtomRegistry.get(errorByConnectionAtom).conn ?? null).toBeNull();
	});

	it("archiveChat rolls back and records the error on RPC failure", async () => {
		rpc.archiveShouldFail = true;
		await archiveChat("conn", options, "chat-1" as never);
		const bundles = appAtomRegistry.get(bundlesByConnectionAtom).conn ?? [];
		expect(bundles[0]?.chats).toHaveLength(1);
		expect(appAtomRegistry.get(errorByConnectionAtom).conn).toContain(
			"server unreachable",
		);
	});

	it("setPermissionMode reverts the optimistic mode on failure", async () => {
		rpc.permissionModeShouldFail = true;
		const ok = await setPermissionMode(
			"conn",
			options,
			"session-1" as never,
			"plan",
		);
		expect(ok).toBe(false);
		const bundles = appAtomRegistry.get(bundlesByConnectionAtom).conn ?? [];
		const session = bundles[0]?.sessions[0] as { permissionMode: string };
		expect(session.permissionMode).toBe("default");
		expect(appAtomRegistry.get(errorByConnectionAtom).conn).toContain(
			"mode rejected",
		);
	});

	it("markChatRead keeps the optimistic stamp when the RPC fails", async () => {
		rpc.markChatReadShouldFail = true;
		const before = Date.now();
		await markChatRead("conn", options, "chat-1" as never);
		const bundles = appAtomRegistry.get(bundlesByConnectionAtom).conn ?? [];
		const chat = bundles[0]?.chats[0] as { lastReadAt: Date };
		expect(chat.lastReadAt.getTime()).toBeGreaterThanOrEqual(before);
	});

	it("keeps patched chats encodable for the offline snapshot", async () => {
		const decoded = Schema.decodeUnknownSync(Chat)({
			id: "chat-1",
			projectId: "project-1",
			worktreeId: null,
			title: "Chat",
			titleProvenance: "pending",
			activeSessionId: "session-1",
			originSessionId: null,
			archivedAt: null,
			lastUserMessageAt: "2026-07-01T00:00:00.000Z",
			lastMessageAt: "2026-07-01T00:00:00.000Z",
			lastReadAt: "2026-06-01T00:00:00.000Z",
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
		});
		appAtomRegistry.set(runtimeBundlesByConnectionAtom, {
			conn: [
				{
					project: {
						id: "project-1",
						name: "Project",
						path: "/tmp/p",
					} as never,
					chats: [decoded],
					sessions: [makeSession()],
				},
			],
		});
		rpc.markChatReadShouldFail = true;
		await markChatRead("conn", options, "chat-1" as never);
		const chat = appAtomRegistry.get(bundlesByConnectionAtom).conn?.[0]
			?.chats[0];
		expect(chat).toBeInstanceOf(Chat);
		expect(() => Schema.encodeSync(Chat)(chat as Chat)).not.toThrow();
	});

	it("markChatRead adopts the canonical server chat on success", async () => {
		await markChatRead("conn", options, "chat-1" as never);
		const bundles = appAtomRegistry.get(bundlesByConnectionAtom).conn ?? [];
		const chat = bundles[0]?.chats[0] as { lastReadAt: Date };
		expect(chat.lastReadAt.toISOString()).toBe(
			new Date("2026-07-02").toISOString(),
		);
	});
});

describe("snapshot subscription recovery", () => {
	it("resubscribes after repeated errors while the socket stays healthy", async () => {
		let attempts = 0;
		const failReady = vi.fn();
		const program = Effect.suspend(() => {
			attempts += 1;
			return attempts < 3
				? Effect.fail(new Error("database unavailable"))
				: Effect.never;
		});
		const fiber = Effect.runFork(
			superviseSnapshotStream(program, {
				connectionKey: "conn",
				connectionOptions: options,
				isReady: () => true,
				failReady,
				completedMessage: "stream completed",
				missingSnapshotMessage: "missing snapshot",
			}),
		);
		try {
			await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 5_000 });
			expect(failReady).not.toHaveBeenCalled();
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	}, 10_000);

	it("fails readiness without retrying when the first snapshot fails", async () => {
		let attempts = 0;
		const failReady = vi.fn();
		await Effect.runPromise(
			superviseSnapshotStream(
				Effect.suspend(() => {
					attempts += 1;
					return Effect.fail(new Error("initial snapshot failed"));
				}),
				{
					connectionKey: "conn",
					connectionOptions: options,
					isReady: () => false,
					failReady,
					completedMessage: "stream completed",
					missingSnapshotMessage: "missing snapshot",
				},
			),
		);
		expect(attempts).toBe(1);
		expect(failReady).toHaveBeenCalled();
	});
});
