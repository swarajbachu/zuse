import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { EnvironmentId } from "@zuse/contracts";
import {
	EMPTY_TERMINALS,
	type TerminalInstance,
	terminalOwnerId,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import { EMPTY_PANELS, rightPaneKey, useUiStore } from "../store/ui.ts";
import { loadTerminalCatalog } from "./terminal-catalog.ts";
import {
	terminalOwnerLimitMessageFor,
	terminalOwnerLimitReached,
} from "./terminal-policy.ts";

export type OpenRightTerminalResult =
	| Readonly<{ status: "ready"; slot: number; reused: boolean }>
	| Readonly<{ status: "cancelled" }>
	| Readonly<{ status: "failed"; cause: unknown }>;

type CurrentAction = Readonly<{ isCurrent?: () => boolean }>;
type RightTerminalProcess =
	| Readonly<{
			title?: undefined;
			command?: undefined;
	  }>
	| Readonly<{
			title: string;
			command?: TerminalInstance["command"];
	  }>;

const actionIsCurrent = (input: CurrentAction): boolean =>
	input.isCurrent?.() !== false;

/**
 * Reconcile the requested environment before adding a right terminal panel.
 * A restored terminal without a panel is surfaced first; a new process is
 * allocated only from an authoritative empty result.
 */
export const restoreOrAddRightTerminal = async (
	input: Readonly<{
		ref: ChatRef;
		environmentId: EnvironmentId;
		cwd: string;
		/** A command action must allocate a new process, never reuse an old shell. */
		reuseRestored?: boolean;
		/**
		 * Re-check the caller's logical chat after the asynchronous catalog read.
		 * This keeps a late response from opening a panel in a chat the user has
		 * already left.
		 */
		isCurrent?: () => boolean;
	}> &
		RightTerminalProcess,
): Promise<OpenRightTerminalResult> => {
	if (!actionIsCurrent(input)) return { status: "cancelled" };
	try {
		await loadTerminalCatalog(input.ref, "right", input.environmentId);
	} catch (cause) {
		return actionIsCurrent(input)
			? { status: "failed", cause }
			: { status: "cancelled" };
	}
	if (!actionIsCurrent(input)) return { status: "cancelled" };

	const terminalStore = useTerminalsStore.getState();
	const terminalKey = terminalsKey(input.ref, "right");
	const terminals = terminalStore.byKey[terminalKey] ?? EMPTY_TERMINALS;
	const ui = useUiStore.getState();
	const occupiedSlots = new Set(
		(ui.rightPanelsByChat[rightPaneKey(input.ref)] ?? EMPTY_PANELS)
			.filter((panel) => panel.kind === "terminal")
			.map((panel) => panel.slot),
	);
	const restoredSlot =
		input.reuseRestored === false
			? -1
			: terminals.findIndex(
					(terminal, slot) =>
						terminal.environmentId === input.environmentId &&
						terminal.serverPtyId !== undefined &&
						!occupiedSlots.has(slot),
				);
	const reused = restoredSlot >= 0;
	const ownerId = terminalOwnerId(input.ref, "right");
	if (
		!reused &&
		terminalOwnerLimitReached(terminals, input.environmentId, ownerId)
	) {
		return {
			status: "failed",
			cause: new Error(
				terminalOwnerLimitMessageFor(input.environmentId, ownerId),
			),
		};
	}
	const slot = reused
		? restoredSlot
		: input.title === undefined
			? terminals.length
			: terminalStore.add(
					input.ref,
					input.environmentId,
					input.cwd,
					input.title,
					input.command,
				);
	if (!reused && input.title === undefined) {
		terminalStore.ensureSlot(input.ref, slot, input.cwd, "right");
	}
	ui.addTerminalPanelForSlot(input.ref, slot);
	ui.setRightSidebarOpenForChat(input.ref, true);
	return { status: "ready", slot, reused };
};

/**
 * Wake a detached cloud workspace, wait for its canonical folder root, then
 * run the same authoritative catalog gate as an already-attached workspace.
 * Every asynchronous boundary re-checks logical chat identity so a late wake
 * cannot open a terminal in a chat the user has left.
 */
export const wakeAndRestoreCloudRightTerminal = async (input: {
	readonly ref: ChatRef;
	readonly title: string;
	readonly getCanonicalRootPath: () => string | null;
	readonly waitForCanonicalRootPath: () => Promise<string>;
	readonly ensureAttached: () => Promise<void>;
	readonly isCurrent?: () => boolean;
}): Promise<OpenRightTerminalResult> => {
	if (!actionIsCurrent(input)) return { status: "cancelled" };
	let cwd = input.getCanonicalRootPath();
	try {
		if (cwd === null) {
			await input.ensureAttached();
			if (!actionIsCurrent(input)) return { status: "cancelled" };
			cwd = input.getCanonicalRootPath();
			if (cwd === null) cwd = await input.waitForCanonicalRootPath();
		}
	} catch (cause) {
		return actionIsCurrent(input)
			? { status: "failed", cause }
			: { status: "cancelled" };
	}
	if (!actionIsCurrent(input)) return { status: "cancelled" };
	return restoreOrAddRightTerminal({
		ref: input.ref,
		environmentId: input.ref.environmentId,
		cwd,
		title: input.title,
		isCurrent: input.isCurrent,
	});
};
