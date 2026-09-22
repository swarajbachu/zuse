import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { PtyId } from "@zuse/contracts";
import {
	EMPTY_TERMINALS,
	type TerminalInstance,
	terminalOwnerId,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import { bottomTerminalLayoutForChat, useUiStore } from "../store/ui.ts";
import { loadTerminalCatalog } from "./terminal-catalog.ts";
import { terminalOwnerLimitReached } from "./terminal-policy.ts";

export type BottomTerminalCatalogResult = "ready" | "failed" | "cancelled";

/**
 * Open a fresh shell in the bottom collection without affecting the existing
 * right-dock collection for the same chat.
 */
export const openNewBottomTerminal = (
	ref: ChatRef,
	cwd: string,
): TerminalInstance | null => {
	const terminals = useTerminalsStore.getState();
	const key = terminalsKey(ref, "bottom");
	const current = terminals.byKey[key] ?? EMPTY_TERMINALS;
	// The visible button is disabled at the limit, but this guard is the final
	// synchronous authority for rapid repeated clicks before React can rerender.
	if (
		terminalOwnerLimitReached(
			current,
			ref.environmentId,
			terminalOwnerId(ref, "bottom"),
		)
	)
		return null;
	const slot = current.length;
	const terminal = terminals.ensureSlot(ref, slot, cwd, "bottom");
	const ui = useUiStore.getState();
	ui.setActiveBottomTerminalForChat(ref, terminal.id);
	ui.setBottomTerminalOpenForChat(ref, true);
	return terminal;
};

/**
 * Reconcile the authoritative server catalog before deciding whether opening
 * the dock needs a new shell. An ambiguous lookup may still reveal an already
 * known renderer terminal, but it must never allocate another owned PTY.
 */
export const restoreOrOpenBottomTerminal = async (
	ref: ChatRef,
	cwd: string,
	options: Readonly<{
		isCurrent?: () => boolean;
		/** Add another shell after hydration instead of only ensuring one exists. */
		createNew?: boolean;
	}> = {},
): Promise<BottomTerminalCatalogResult> => {
	if (options.isCurrent?.() === false) return "cancelled";
	let catalogReady = true;
	try {
		await loadTerminalCatalog(ref, "bottom", ref.environmentId);
	} catch {
		catalogReady = false;
	}
	if (options.isCurrent?.() === false) return "cancelled";

	const ui = useUiStore.getState();
	const key = terminalsKey(ref, "bottom");
	const latest = useTerminalsStore.getState().byKey[key] ?? EMPTY_TERMINALS;
	if (options.createNew === true) {
		if (catalogReady) openNewBottomTerminal(ref, cwd);
		ui.setBottomTerminalOpenForChat(ref, true);
		return catalogReady ? "ready" : "failed";
	}
	if (latest.length === 0) {
		if (catalogReady) openNewBottomTerminal(ref, cwd);
		else ui.setBottomTerminalOpenForChat(ref, true);
		return catalogReady ? "ready" : "failed";
	}

	const layout = bottomTerminalLayoutForChat(ui, ref);
	if (!latest.some((terminal) => terminal.id === layout.activeTerminalId)) {
		ui.setActiveBottomTerminalForChat(ref, latest[0]?.id ?? null);
	}
	ui.setBottomTerminalOpenForChat(ref, true);
	return catalogReady ? "ready" : "failed";
};

/**
 * Explicit close owns PTY teardown. Hiding/collapsing the dock deliberately
 * never calls this function, so its shell remains attachable when reopened.
 */
export const closeBottomTerminalTab = (ref: ChatRef, id: PtyId): void => {
	const terminals = useTerminalsStore.getState();
	const key = terminalsKey(ref, "bottom");
	const before = terminals.byKey[key] ?? EMPTY_TERMINALS;
	const closedIndex = before.findIndex((terminal) => terminal.id === id);
	if (closedIndex === -1) return;

	const layout = bottomTerminalLayoutForChat(useUiStore.getState(), ref);
	terminals.remove(ref, id, "bottom");
	const remaining = useTerminalsStore.getState().byKey[key] ?? EMPTY_TERMINALS;
	const ui = useUiStore.getState();
	if (remaining.length === 0) {
		ui.setActiveBottomTerminalForChat(ref, null);
		ui.setBottomTerminalOpenForChat(ref, false);
		return;
	}

	if (
		layout.activeTerminalId === id ||
		!remaining.some((terminal) => terminal.id === layout.activeTerminalId)
	) {
		const next = remaining[Math.max(0, closedIndex - 1)] ?? remaining[0];
		ui.setActiveBottomTerminalForChat(ref, next?.id ?? null);
	}
};
