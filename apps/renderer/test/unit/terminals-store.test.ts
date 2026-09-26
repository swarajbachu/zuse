import {
	type ChatId,
	EnvironmentId,
	PtyId,
	PtyOpenToken,
	PtySummary,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalog = (terminals: ReadonlyArray<PtySummary>, liveLimit = 4) => ({
	terminals,
	liveLimit,
});

const terminalRegistry = vi.hoisted(() => ({
	dispose: vi.fn(async () => undefined),
	reconcilePtyBinding: vi.fn(() => true),
}));
const terminalClient = vi.hoisted(() => ({
	dispatchTerminalCloseOwned: vi.fn(async () => 0),
}));

vi.mock("../../src/lib/terminal-registry.ts", () => terminalRegistry);
vi.mock("../../src/lib/terminal-client-bus.ts", () => terminalClient);
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getLocalEnvironmentId: () => "local-desktop",
}));

import { terminalOwnerLimitReached } from "../../src/lib/terminal-policy.ts";
import {
	terminalOwnerCleanupTargets,
	terminalOwnerId,
	terminalsKey,
	useTerminalsStore,
} from "../../src/store/terminals.ts";
import { rightPaneKey, useUiStore } from "../../src/store/ui.ts";

describe("qualified terminals store", () => {
	beforeEach(() => {
		useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });
		terminalRegistry.dispose.mockClear();
		terminalRegistry.reconcilePtyBinding.mockClear();
		terminalClient.dispatchTerminalCloseOwned.mockClear();
		useUiStore.setState({
			rightPanelsByChat: {},
			activeRightPanelByChat: {},
		});
	});

	it("isolates equal chat ids across environments", () => {
		const chatId = "same-chat" as ChatId;
		const first = { environmentId: EnvironmentId.make("computer-a"), chatId };
		const second = { environmentId: EnvironmentId.make("computer-b"), chatId };
		const store = useTerminalsStore.getState();

		const terminalA = store.ensureSlot(first, 0, "/workspace/a");
		const terminalB = store.ensureSlot(second, 0, "/workspace/b");

		expect(terminalsKey(first)).not.toBe(terminalsKey(second));
		expect(terminalA.environmentId).toBe(first.environmentId);
		expect(terminalB.environmentId).toBe(second.environmentId);
		expect(terminalA.id).not.toBe(terminalB.id);
		expect(useTerminalsStore.getState().byKey[terminalsKey(first)]).toEqual([
			terminalA,
		]);
		expect(useTerminalsStore.getState().byKey[terminalsKey(second)]).toEqual([
			terminalB,
		]);
	});

	it("keeps a local shell owned by its cloud chat", () => {
		const ref = {
			environmentId: EnvironmentId.make("cloud-workspace"),
			chatId: "cloud-chat" as ChatId,
		};
		const localEnvironmentId = EnvironmentId.make("desktop");
		const store = useTerminalsStore.getState();

		const slot = store.add(
			ref,
			localEnvironmentId,
			"/Users/me/.zuse/cloud/repo/branch",
			"Local",
		);
		const terminal =
			useTerminalsStore.getState().byKey[terminalsKey(ref)]?.[slot];

		expect(terminal?.environmentId).toBe(localEnvironmentId);
		expect(terminal?.cwd).toBe("/Users/me/.zuse/cloud/repo/branch");
		expect(store.ensureSlot(ref, slot, "/home/zuse/workspace")).toBe(terminal);
	});

	it("uses stable independent owners for right and bottom collections", () => {
		const ref = {
			environmentId: EnvironmentId.make("computer-a"),
			chatId: "chat-a" as ChatId,
		};

		expect(terminalOwnerId(ref, "right")).toBe(terminalOwnerId(ref, "right"));
		expect(terminalOwnerId(ref, "right")).not.toBe(
			terminalOwnerId(ref, "bottom"),
		);
	});

	it("reconciles an owned server catalog without replacing pending opens", () => {
		const ref = {
			environmentId: EnvironmentId.make("computer-a"),
			chatId: "chat-a" as ChatId,
		};
		const store = useTerminalsStore.getState();
		const pending = store.ensureSlot(ref, 0, "/workspace", "bottom");
		const existingId = PtyId.make("existing-pty");
		store.reconcileOwned(
			ref,
			ref.environmentId,
			"bottom",
			catalog([
				PtySummary.make({
					ptyId: existingId,
					cwd: "/workspace",
					label: "server shell",
					scope: "session",
					status: "running",
					cols: 100,
					rows: 30,
					processEpoch: "epoch-1",
					latestOutputSequence: 12,
				}),
			]),
		);

		const reconciled =
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")];
		expect(reconciled).toHaveLength(2);
		expect(reconciled?.[0]).toBe(pending);
		expect(reconciled?.[1]).toMatchObject({
			id: existingId,
			serverPtyId: existingId,
			title: "server shell",
			processEpoch: "epoch-1",
		});
	});

	it("binds a lost-open acknowledgement back to its pending logical slot", async () => {
		const ref = {
			environmentId: EnvironmentId.make("computer-a"),
			chatId: "chat-a" as ChatId,
		};
		const store = useTerminalsStore.getState();
		const pending = store.ensureSlot(ref, 0, "/workspace", "bottom");
		const serverPtyId = PtyId.make("server-pty-after-lost-ack");
		store.reconcileOwned(
			ref,
			ref.environmentId,
			"bottom",
			catalog([
				PtySummary.make({
					ptyId: serverPtyId,
					cwd: "/workspace",
					label: "Recovered shell",
					scope: "session",
					status: "running",
					cols: 100,
					rows: 30,
					processEpoch: "epoch-recovered",
					latestOutputSequence: 0,
					openToken: PtyOpenToken.make(pending.id),
				}),
			]),
		);

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")],
		).toEqual([
			{
				...pending,
				serverPtyId,
				processEpoch: "epoch-recovered",
				status: "running",
				title: "Recovered shell",
			},
		]);
		await vi.waitFor(() =>
			expect(terminalRegistry.reconcilePtyBinding).toHaveBeenCalledWith(
				ref.environmentId,
				pending.id,
				serverPtyId,
				"epoch-recovered",
			),
		);
	});

	it("restores the logical identity from a token after a cold renderer reload", () => {
		const ref = {
			environmentId: EnvironmentId.make("computer-a"),
			chatId: "chat-a" as ChatId,
		};
		const logicalId = PtyOpenToken.make("logical-terminal-after-reload");
		const serverPtyId = PtyId.make("server-terminal-after-reload");
		useTerminalsStore.getState().reconcileOwned(
			ref,
			ref.environmentId,
			"right",
			catalog([
				PtySummary.make({
					ptyId: serverPtyId,
					cwd: "/workspace",
					label: null,
					scope: "session",
					status: "running",
					cols: 80,
					rows: 24,
					processEpoch: "epoch-reloaded",
					latestOutputSequence: 0,
					openToken: logicalId,
				}),
			]),
		);

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref)]?.[0],
		).toMatchObject({
			id: PtyId.make(logicalId),
			serverPtyId,
		});
	});

	it("derives authoritative cleanup owners without hydrated terminal slots", () => {
		const ref = {
			environmentId: EnvironmentId.make("cloud-workspace"),
			chatId: "archived-chat" as ChatId,
		};
		const localEnvironmentId = EnvironmentId.make("local-desktop");
		expect(terminalOwnerCleanupTargets(ref, localEnvironmentId)).toEqual([
			{
				environmentId: ref.environmentId,
				ownerId: terminalOwnerId(ref, "right"),
			},
			{
				environmentId: ref.environmentId,
				ownerId: terminalOwnerId(ref, "bottom"),
			},
			{
				environmentId: localEnvironmentId,
				ownerId: terminalOwnerId(ref, "right"),
			},
			{
				environmentId: localEnvironmentId,
				ownerId: terminalOwnerId(ref, "bottom"),
			},
		]);
		expect(terminalOwnerCleanupTargets(ref, ref.environmentId)).toHaveLength(2);
	});

	it("dispatches authoritative owner cleanup even when the chat store is cold", async () => {
		const ref = {
			environmentId: EnvironmentId.make("cloud-workspace"),
			chatId: "cold-archived-chat" as ChatId,
		};
		useTerminalsStore.getState().disposeChat(ref);

		await vi.waitFor(() =>
			expect(terminalClient.dispatchTerminalCloseOwned).toHaveBeenCalledTimes(
				4,
			),
		);
		expect(terminalClient.dispatchTerminalCloseOwned.mock.calls).toEqual([
			[ref.environmentId, terminalOwnerId(ref, "right")],
			[ref.environmentId, terminalOwnerId(ref, "bottom")],
			[EnvironmentId.make("local-desktop"), terminalOwnerId(ref, "right")],
			[EnvironmentId.make("local-desktop"), terminalOwnerId(ref, "bottom")],
		]);
	});

	it("binds a newly opened PTY and keeps its editable title canonical", () => {
		const ref = {
			environmentId: EnvironmentId.make("computer-a"),
			chatId: "chat-a" as ChatId,
		};
		const store = useTerminalsStore.getState();
		const pending = store.ensureSlot(ref, 0, "/workspace");
		const serverPtyId = PtyId.make("server-pty");

		store.bindPty(ref, pending.id, "right", serverPtyId, "epoch-2");
		store.rename(ref, pending.id, "right", "build shell");

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref)]?.[0],
		).toMatchObject({
			id: pending.id,
			serverPtyId,
			processEpoch: "epoch-2",
			title: "build shell",
		});
	});

	it("releases authoritative occupancy when the retained runtime exits", () => {
		const ref = {
			environmentId: EnvironmentId.make("runtime-exit-environment"),
			chatId: "runtime-exit-chat" as ChatId,
		};
		const store = useTerminalsStore.getState();
		const summaries = Array.from({ length: 4 }, (_, index) =>
			PtySummary.make({
				ptyId: PtyId.make(`runtime-exit-pty-${index}`),
				cwd: `/workspace/${index}`,
				label: `Shell ${index + 1}`,
				scope: "session",
				status: "running",
				cols: 80,
				rows: 24,
				processEpoch: `runtime-exit-epoch-${index}`,
				latestOutputSequence: 0,
			}),
		);
		store.reconcileOwned(ref, ref.environmentId, "right", catalog(summaries));
		const ownerId = terminalOwnerId(ref, "right");
		const terminals =
			useTerminalsStore.getState().byKey[terminalsKey(ref)] ?? [];
		expect(
			terminalOwnerLimitReached(terminals, ref.environmentId, ownerId),
		).toBe(true);

		store.observeRuntimeStatus(
			ref,
			summaries[0]?.ptyId ?? PtyId.make("missing"),
			"right",
			"exited",
		);

		expect(
			terminalOwnerLimitReached(
				useTerminalsStore.getState().byKey[terminalsKey(ref)] ?? [],
				ref.environmentId,
				ownerId,
			),
		).toBe(false);
	});

	it.each([
		"right",
		"bottom",
	] as const)("releases %s occupancy on explicit close without disturbing the other placement", (placement) => {
		const ref = {
			environmentId: EnvironmentId.make(`explicit-close-${placement}`),
			chatId: `explicit-close-${placement}-chat` as ChatId,
		};
		const otherPlacement = placement === "right" ? "bottom" : "right";
		const summariesFor = (prefix: string) =>
			Array.from({ length: 4 }, (_, index) =>
				PtySummary.make({
					ptyId: PtyId.make(`${prefix}-pty-${index}`),
					cwd: `/workspace/${prefix}/${index}`,
					label: `${prefix} shell ${index + 1}`,
					scope: "session",
					status: "running",
					cols: 80,
					rows: 24,
					processEpoch: `${prefix}-epoch-${index}`,
					latestOutputSequence: 0,
				}),
			);
		const summaries = summariesFor(placement);
		const otherSummaries = summariesFor(otherPlacement);
		const store = useTerminalsStore.getState();
		store.reconcileOwned(ref, ref.environmentId, placement, catalog(summaries));
		store.reconcileOwned(
			ref,
			ref.environmentId,
			otherPlacement,
			catalog(otherSummaries),
		);
		const ownerId = terminalOwnerId(ref, placement);
		const otherOwnerId = terminalOwnerId(ref, otherPlacement);
		const limitReached = (
			targetPlacement: typeof placement,
			targetOwnerId: typeof ownerId,
		) =>
			terminalOwnerLimitReached(
				useTerminalsStore.getState().byKey[
					terminalsKey(ref, targetPlacement)
				] ?? [],
				ref.environmentId,
				targetOwnerId,
			);

		expect(limitReached(placement, ownerId)).toBe(true);
		expect(limitReached(otherPlacement, otherOwnerId)).toBe(true);

		const closedId = summaries[0]?.ptyId;
		if (closedId === undefined) throw new Error("Expected a terminal to close");
		store.remove(ref, closedId, placement);

		expect(limitReached(placement, ownerId)).toBe(false);
		expect(limitReached(otherPlacement, otherOwnerId)).toBe(true);

		// A catalog request already in flight may still include the closed PTY.
		// Its close tombstone must keep both the list and occupancy released.
		store.reconcileOwned(ref, ref.environmentId, placement, catalog(summaries));
		expect(limitReached(placement, ownerId)).toBe(false);

		// A new local reservation consumes exactly the newly released slot.
		store.ensureSlot(ref, 3, "/workspace/replacement", placement);
		expect(limitReached(placement, ownerId)).toBe(true);
		expect(limitReached(otherPlacement, otherOwnerId)).toBe(true);
	});

	it("does not resurrect an explicitly closed PTY from an older catalog response", () => {
		const ref = {
			environmentId: EnvironmentId.make("close-race-environment"),
			chatId: "close-race-chat" as ChatId,
		};
		const store = useTerminalsStore.getState();
		const closedId = PtyId.make("closed-server-pty");
		const closedSummary = PtySummary.make({
			ptyId: closedId,
			cwd: "/workspace",
			label: "closed shell",
			scope: "session",
			status: "running",
			cols: 80,
			rows: 24,
			processEpoch: "closed-epoch",
			latestOutputSequence: 2,
		});

		store.reconcileOwned(
			ref,
			ref.environmentId,
			"bottom",
			catalog([closedSummary]),
		);
		store.remove(ref, closedId, "bottom");
		store.reconcileOwned(
			ref,
			ref.environmentId,
			"bottom",
			catalog([closedSummary]),
		);

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")],
		).toEqual([]);

		// Once a newer authoritative catalog confirms absence, the tombstone is
		// released instead of accumulating for the renderer's entire lifetime.
		store.reconcileOwned(ref, ref.environmentId, "bottom", catalog([]));
		store.reconcileOwned(
			ref,
			ref.environmentId,
			"bottom",
			catalog([closedSummary]),
		);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")],
		).toEqual([expect.objectContaining({ serverPtyId: closedId })]);
	});

	it("remaps right-panel slots when catalog removal compacts the terminal list", () => {
		const ref = {
			environmentId: EnvironmentId.make("catalog-environment"),
			chatId: "catalog-chat" as ChatId,
		};
		const store = useTerminalsStore.getState();
		const firstIndex = store.add(ref, ref.environmentId, "/first", "First");
		const secondIndex = store.add(ref, ref.environmentId, "/second", "Second");
		const [first, second] =
			useTerminalsStore.getState().byKey[terminalsKey(ref)] ?? [];
		if (first === undefined || second === undefined) {
			throw new Error("Expected two terminal instances");
		}
		const firstServerId = PtyId.make("first-server-pty");
		const secondServerId = PtyId.make("second-server-pty");
		store.bindPty(ref, first.id, "right", firstServerId, "first-epoch");
		store.bindPty(ref, second.id, "right", secondServerId, "second-epoch");
		const ui = useUiStore.getState();
		ui.addTerminalPanelForSlot(ref, firstIndex);
		ui.addTerminalPanelForSlot(ref, secondIndex);
		const originalPanels =
			useUiStore.getState().rightPanelsByChat[rightPaneKey(ref)] ?? [];
		const survivingPanelId = originalPanels[1]?.id;

		store.reconcileOwned(
			ref,
			ref.environmentId,
			"right",
			catalog([
				PtySummary.make({
					ptyId: secondServerId,
					cwd: "/second",
					label: "Second",
					scope: "session",
					status: "running",
					cols: 80,
					rows: 24,
					processEpoch: "second-epoch",
					latestOutputSequence: 0,
				}),
			]),
		);

		expect(useTerminalsStore.getState().byKey[terminalsKey(ref)]).toMatchObject(
			[{ id: second.id, serverPtyId: secondServerId }],
		);
		expect(useUiStore.getState().rightPanelsByChat[rightPaneKey(ref)]).toEqual([
			{ id: survivingPanelId, kind: "terminal", slot: 0 },
		]);
		expect(
			useUiStore.getState().activeRightPanelByChat[rightPaneKey(ref)],
		).toBe(survivingPanelId);
	});
});
