import {
	type ChatId,
	EnvironmentId,
	PtyId,
	PtyOwnerId,
	PtySummary,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalClient = vi.hoisted(() => ({
	listOwnedTerminals: vi.fn(),
}));

vi.mock("../../src/lib/terminal-client-bus.ts", () => ({
	listOwnedTerminals: terminalClient.listOwnedTerminals,
}));

import {
	hydrateRightTerminalCatalog,
	invalidateTerminalCatalog,
	loadTerminalCatalog,
	terminalCatalogKey,
} from "../../src/lib/terminal-catalog.ts";
import {
	terminalOwnerId,
	terminalsKey,
	useTerminalsStore,
} from "../../src/store/terminals.ts";

const summary = (ptyId: string) =>
	PtySummary.make({
		ptyId: PtyId.make(ptyId),
		cwd: "/workspace",
		label: "restored shell",
		scope: "session",
		status: "running",
		cols: 100,
		rows: 30,
		processEpoch: `epoch:${ptyId}`,
		latestOutputSequence: 4,
	});
const catalogResult = (...terminals: ReadonlyArray<PtySummary>) => ({
	terminals,
	liveLimit: 4,
});
type CatalogResult = ReturnType<typeof catalogResult>;

describe("terminal catalog", () => {
	beforeEach(() => {
		terminalClient.listOwnedTerminals.mockReset();
		useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });
	});

	it("uses an unambiguous environment and owner identity", () => {
		expect(
			terminalCatalogKey(
				EnvironmentId.make("environment"),
				PtyOwnerId.make("owner:segment"),
			),
		).not.toBe(
			terminalCatalogKey(
				EnvironmentId.make("environment:owner"),
				PtyOwnerId.make("segment"),
			),
		);
	});

	it("deduplicates concurrent loads and reconciles the owned server PTYs", async () => {
		const ref = {
			environmentId: EnvironmentId.make("catalog-environment"),
			chatId: "catalog-chat" as ChatId,
		};
		let resolveList: ((value: CatalogResult) => void) | undefined;
		terminalClient.listOwnedTerminals.mockReturnValue(
			new Promise<CatalogResult>((resolve) => {
				resolveList = resolve;
			}),
		);

		const first = loadTerminalCatalog(ref, "bottom", ref.environmentId);
		const second = loadTerminalCatalog(ref, "bottom", ref.environmentId);
		expect(first).toBe(second);
		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledOnce();
		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledWith(
			ref.environmentId,
			terminalOwnerId(ref, "bottom"),
		);

		resolveList?.(catalogResult(summary("restored-pty")));
		await first;

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")],
		).toEqual([
			expect.objectContaining({
				id: PtyId.make("restored-pty"),
				serverPtyId: PtyId.make("restored-pty"),
				processEpoch: "epoch:restored-pty",
			}),
		]);

		terminalClient.listOwnedTerminals.mockResolvedValue(
			catalogResult(summary("restored-pty")),
		);
		await loadTerminalCatalog(ref, "bottom", ref.environmentId);
		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledTimes(2);
	});

	it("evicts a failed load so the next attempt reaches the server", async () => {
		const ref = {
			environmentId: EnvironmentId.make("retry-environment"),
			chatId: "retry-chat" as ChatId,
		};
		terminalClient.listOwnedTerminals
			.mockRejectedValueOnce(new Error("connection dropped"))
			.mockResolvedValueOnce(catalogResult(summary("retry-pty")));

		await expect(
			loadTerminalCatalog(ref, "right", ref.environmentId),
		).rejects.toThrow("connection dropped");
		await loadTerminalCatalog(ref, "right", ref.environmentId);

		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledTimes(2);
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "right")],
		).toHaveLength(1);
	});

	it("ignores an older response superseded by a forced refresh", async () => {
		const ref = {
			environmentId: EnvironmentId.make("refresh-environment"),
			chatId: "refresh-chat" as ChatId,
		};
		let resolveOlder: ((value: CatalogResult) => void) | undefined;
		let resolveNewer: ((value: CatalogResult) => void) | undefined;
		terminalClient.listOwnedTerminals
			.mockReturnValueOnce(
				new Promise<CatalogResult>((resolve) => {
					resolveOlder = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise<CatalogResult>((resolve) => {
					resolveNewer = resolve;
				}),
			);

		const older = loadTerminalCatalog(ref, "bottom", ref.environmentId);
		const newer = loadTerminalCatalog(ref, "bottom", ref.environmentId, {
			force: true,
		});
		resolveNewer?.(catalogResult());
		await newer;
		resolveOlder?.(catalogResult(summary("stale-pty")));
		await expect(older).rejects.toThrow("superseded");

		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")],
		).toEqual([]);
	});

	it("rejects an invalidated response so callers cannot allocate from ambiguity", async () => {
		const ref = {
			environmentId: EnvironmentId.make("invalidated-environment"),
			chatId: "invalidated-chat" as ChatId,
		};
		let resolveList: ((value: CatalogResult) => void) | undefined;
		terminalClient.listOwnedTerminals.mockReturnValue(
			new Promise<CatalogResult>((resolve) => {
				resolveList = resolve;
			}),
		);

		const pending = loadTerminalCatalog(ref, "bottom", ref.environmentId);
		invalidateTerminalCatalog(ref, "bottom", ref.environmentId);
		resolveList?.(catalogResult());

		await expect(pending).rejects.toThrow("superseded");
		expect(
			useTerminalsStore.getState().byKey[terminalsKey(ref, "bottom")],
		).toBeUndefined();
	});

	it("hydrates cloud and local right-terminal catalogs through one authority", async () => {
		const ref = {
			environmentId: EnvironmentId.make("cloud-environment"),
			chatId: "cloud-chat" as ChatId,
		};
		const localEnvironmentId = EnvironmentId.make("local-environment");
		terminalClient.listOwnedTerminals.mockResolvedValue(catalogResult());

		await hydrateRightTerminalCatalog(ref, localEnvironmentId);

		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledTimes(2);
		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledWith(
			ref.environmentId,
			terminalOwnerId(ref, "right"),
		);
		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledWith(
			localEnvironmentId,
			terminalOwnerId(ref, "right"),
		);
	});

	it("restores only local right terminals when the cloud owner is unavailable", async () => {
		const ref = {
			environmentId: EnvironmentId.make("unavailable-cloud"),
			chatId: "offline-cloud-chat" as ChatId,
		};
		const localEnvironmentId = EnvironmentId.make("available-local");
		terminalClient.listOwnedTerminals.mockResolvedValue(catalogResult());

		await hydrateRightTerminalCatalog(ref, localEnvironmentId, {
			includeOwnerEnvironment: false,
		});

		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledOnce();
		expect(terminalClient.listOwnedTerminals).toHaveBeenCalledWith(
			localEnvironmentId,
			terminalOwnerId(ref, "right"),
		);
	});
});
