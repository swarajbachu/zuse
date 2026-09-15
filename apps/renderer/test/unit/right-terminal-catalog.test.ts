import { type ChatId, EnvironmentId, PtyId, PtySummary } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
	loadTerminalCatalog: vi.fn(),
}));

vi.mock("../../src/lib/terminal-catalog.ts", () => ({
	loadTerminalCatalog: catalog.loadTerminalCatalog,
}));

import {
	restoreOrAddRightTerminal,
	wakeAndRestoreCloudRightTerminal,
} from "../../src/lib/right-terminal-controller.ts";
import { terminalsKey, useTerminalsStore } from "../../src/store/terminals.ts";
import { rightPaneKey, useUiStore } from "../../src/store/ui.ts";

const chatRef = {
	environmentId: EnvironmentId.make("catalog-cloud"),
	chatId: "right-catalog-chat" as ChatId,
};

const restoredSummary = PtySummary.make({
	ptyId: PtyId.make("restored-right-pty"),
	cwd: "/workspace",
	label: "Restored",
	scope: "session",
	status: "running",
	cols: 100,
	rows: 30,
	processEpoch: "restored-epoch",
	latestOutputSequence: 4,
});
const terminalCatalog = (
	terminals: ReadonlyArray<PtySummary>,
	liveLimit = 4,
) => ({ terminals, liveLimit });

const summaries = (status: "running" | "exited") =>
	Array.from({ length: 4 }, (_, index) =>
		PtySummary.make({
			ptyId: PtyId.make(`${status}-pty-${index}`),
			cwd: `/workspace/${index}`,
			label: `${status} ${index + 1}`,
			scope: "session",
			status,
			cols: 100,
			rows: 30,
			processEpoch: `${status}-epoch-${index}`,
			latestOutputSequence: 4,
		}),
	);

const deferred = <A>() => {
	let resolve!: (value: A | PromiseLike<A>) => void;
	let reject!: (cause?: unknown) => void;
	const promise = new Promise<A>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
};

describe("right terminal catalog gate", () => {
	beforeEach(() => {
		catalog.loadTerminalCatalog.mockReset();
		useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });
		useUiStore.setState({
			rightPaneLayoutByChat: {},
			rightPanelsByChat: {},
			activeRightPanelByChat: {},
		});
	});

	it("does not allocate while hydration is slow and then surfaces the restored slot", async () => {
		const hydration = deferred<void>();
		catalog.loadTerminalCatalog.mockReturnValue(hydration.promise);

		const resultPromise = restoreOrAddRightTerminal({
			ref: chatRef,
			environmentId: chatRef.environmentId,
			cwd: "/workspace",
			title: "Cloud",
		});

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toBeUndefined();
		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(chatRef)],
		).toBeUndefined();

		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog([restoredSummary]),
			);
		hydration.resolve();

		await expect(resultPromise).resolves.toEqual({
			status: "ready",
			slot: 0,
			reused: true,
		});
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toHaveLength(1);
		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(chatRef)],
		).toMatchObject([{ kind: "terminal", slot: 0 }]);
		expect(
			useUiStore.getState().rightPaneLayoutByChat[rightPaneKey(chatRef)]?.open,
		).toBe(true);
	});

	it("never allocates when a delayed authoritative lookup is lost", async () => {
		const hydration = deferred<void>();
		catalog.loadTerminalCatalog.mockReturnValue(hydration.promise);
		const resultPromise = restoreOrAddRightTerminal({
			ref: chatRef,
			environmentId: chatRef.environmentId,
			cwd: "/workspace",
			title: "Run",
			command: { cmd: "/bin/zsh", args: ["-lc", "bun run dev"] },
			reuseRestored: false,
		});

		hydration.reject(new Error("connection lost"));

		await expect(resultPromise).resolves.toMatchObject({ status: "failed" });
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toBeUndefined();
		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(chatRef)],
		).toBeUndefined();
	});

	it("does not open a stale chat when hydration settles after navigation", async () => {
		const hydration = deferred<void>();
		catalog.loadTerminalCatalog.mockReturnValue(hydration.promise);
		let current = true;
		const resultPromise = restoreOrAddRightTerminal({
			ref: chatRef,
			environmentId: chatRef.environmentId,
			cwd: "/workspace",
			title: "Cloud",
			isCurrent: () => current,
		});

		current = false;
		hydration.resolve();

		await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toBeUndefined();
		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(chatRef)],
		).toBeUndefined();
	});

	it("allocates a new slot when every restored terminal already has a panel", async () => {
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);
		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog([restoredSummary]),
			);
		useUiStore.getState().addTerminalPanelForSlot(chatRef, 0);

		await expect(
			restoreOrAddRightTerminal({
				ref: chatRef,
				environmentId: chatRef.environmentId,
				cwd: "/workspace",
				title: "Cloud",
			}),
		).resolves.toEqual({ status: "ready", slot: 1, reused: false });
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toHaveLength(2);
		expect(
			useUiStore
				.getState()
				.rightPanelsByChat[rightPaneKey(chatRef)]?.map((panel) =>
					panel.kind === "terminal" ? panel.slot : null,
				),
		).toEqual([0, 1]);
	});

	it("uses the canonical shell title when a local-project menu adds a terminal", async () => {
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);

		await expect(
			restoreOrAddRightTerminal({
				ref: chatRef,
				environmentId: chatRef.environmentId,
				cwd: "/workspace",
			}),
		).resolves.toEqual({ status: "ready", slot: 0, reused: false });
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)]?.[0]?.title,
		).toBe("zsh");
	});

	it("gates command terminals and never reuses an unrelated restored shell", async () => {
		const hydration = deferred<void>();
		catalog.loadTerminalCatalog.mockReturnValue(hydration.promise);
		const command = {
			cmd: "/bin/zsh",
			args: ["-lc", "bun run dev"],
		} as const;
		const resultPromise = restoreOrAddRightTerminal({
			ref: chatRef,
			environmentId: chatRef.environmentId,
			cwd: "/workspace",
			title: "Run",
			command,
			reuseRestored: false,
		});

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toBeUndefined();
		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog([restoredSummary]),
			);
		hydration.resolve();

		await expect(resultPromise).resolves.toEqual({
			status: "ready",
			slot: 1,
			reused: false,
		});
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)]?.[1],
		).toMatchObject({ title: "Run", command });
		expect(
			useUiStore.getState().rightPanelsByChat[rightPaneKey(chatRef)],
		).toMatchObject([{ kind: "terminal", slot: 1 }]);
	});

	it("does not allocate beyond the owner limit after authoritative hydration", async () => {
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);
		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog([], 4),
			);
		for (let index = 0; index < 4; index += 1) {
			const slot = useTerminalsStore
				.getState()
				.add(
					chatRef,
					chatRef.environmentId,
					`/workspace/${index}`,
					`Cloud ${index + 1}`,
				);
			useUiStore.getState().addTerminalPanelForSlot(chatRef, slot);
		}

		await expect(
			restoreOrAddRightTerminal({
				ref: chatRef,
				environmentId: chatRef.environmentId,
				cwd: "/workspace/new",
				title: "Run",
				command: { cmd: "/bin/zsh", args: ["-lc", "bun run dev"] },
				reuseRestored: false,
			}),
		).resolves.toMatchObject({
			status: "failed",
			cause: expect.objectContaining({
				message: "Terminal limit reached (4). Close a terminal, then retry.",
			}),
		});
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toHaveLength(4);
	});

	it("allows a new terminal when four restored terminals have exited", async () => {
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);
		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog(summaries("exited"), 4),
			);

		await expect(
			restoreOrAddRightTerminal({
				ref: chatRef,
				environmentId: chatRef.environmentId,
				cwd: "/workspace/new",
				title: "New shell",
				reuseRestored: false,
			}),
		).resolves.toMatchObject({ status: "ready", slot: 4, reused: false });
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toHaveLength(5);
	});

	it("blocks a new terminal when four authoritative terminals are running", async () => {
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);
		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog(summaries("running"), 4),
			);

		await expect(
			restoreOrAddRightTerminal({
				ref: chatRef,
				environmentId: chatRef.environmentId,
				cwd: "/workspace/new",
				title: "New shell",
				reuseRestored: false,
			}),
		).resolves.toMatchObject({
			status: "failed",
			cause: expect.objectContaining({
				message: "Terminal limit reached (4). Close a terminal, then retry.",
			}),
		});
	});

	it("wakes an unavailable workspace, waits for its latest root, then hydrates before reuse", async () => {
		const attachment = deferred<void>();
		const root = deferred<string>();
		const hydration = deferred<void>();
		const ensureAttached = vi.fn(() => attachment.promise);
		const waitForCanonicalRootPath = vi.fn(() => root.promise);
		catalog.loadTerminalCatalog.mockReturnValue(hydration.promise);

		const resultPromise = wakeAndRestoreCloudRightTerminal({
			ref: chatRef,
			title: "Cloud",
			getCanonicalRootPath: () => null,
			waitForCanonicalRootPath,
			ensureAttached,
		});
		expect(ensureAttached).toHaveBeenCalledOnce();
		expect(catalog.loadTerminalCatalog).not.toHaveBeenCalled();

		attachment.resolve();
		await Promise.resolve();
		expect(waitForCanonicalRootPath).toHaveBeenCalledOnce();
		expect(catalog.loadTerminalCatalog).not.toHaveBeenCalled();

		root.resolve("/cloud/canonical-root");
		await Promise.resolve();
		expect(catalog.loadTerminalCatalog).toHaveBeenCalledWith(
			chatRef,
			"right",
			chatRef.environmentId,
		);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)],
		).toBeUndefined();

		useTerminalsStore
			.getState()
			.reconcileOwned(
				chatRef,
				chatRef.environmentId,
				"right",
				terminalCatalog([restoredSummary]),
			);
		hydration.resolve();

		await expect(resultPromise).resolves.toEqual({
			status: "ready",
			slot: 0,
			reused: true,
		});
	});

	it("reports an attachment failure and can retry the full authoritative path", async () => {
		const attachFailure = new Error("resume failed");
		const ensureAttached = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(attachFailure)
			.mockResolvedValueOnce(undefined);
		let rootPath: string | null = null;
		const waitForCanonicalRootPath = vi.fn(async () => {
			rootPath = "/cloud/retried-root";
			return rootPath;
		});
		catalog.loadTerminalCatalog.mockResolvedValue(undefined);
		const input = () => ({
			ref: chatRef,
			title: "Cloud",
			getCanonicalRootPath: () => rootPath,
			waitForCanonicalRootPath,
			ensureAttached,
		});

		await expect(wakeAndRestoreCloudRightTerminal(input())).resolves.toEqual({
			status: "failed",
			cause: attachFailure,
		});
		expect(catalog.loadTerminalCatalog).not.toHaveBeenCalled();

		await expect(wakeAndRestoreCloudRightTerminal(input())).resolves.toEqual({
			status: "ready",
			slot: 0,
			reused: false,
		});
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(chatRef)]?.[0]?.cwd,
		).toBe("/cloud/retried-root");
	});

	it("cancels navigation during cloud attachment before waiting or hydrating", async () => {
		const attachment = deferred<void>();
		let current = true;
		const waitForCanonicalRootPath = vi.fn(async () => "/cloud/root");
		const resultPromise = wakeAndRestoreCloudRightTerminal({
			ref: chatRef,
			title: "Cloud",
			getCanonicalRootPath: () => null,
			waitForCanonicalRootPath,
			ensureAttached: () => attachment.promise,
			isCurrent: () => current,
		});

		current = false;
		attachment.resolve();

		await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
		expect(waitForCanonicalRootPath).not.toHaveBeenCalled();
		expect(catalog.loadTerminalCatalog).not.toHaveBeenCalled();
	});
});
