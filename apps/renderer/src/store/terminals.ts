import {
	type ChatRef,
	resourceRefKey,
} from "@zuse/client-runtime/resource-ref";
import type { TerminalCatalog } from "@zuse/client-runtime/terminal-catalog";
import {
	EnvironmentId,
	PtyId,
	PtyOwnerId,
	type PtySummary,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import type { TerminalRuntimeStatus } from "../lib/terminal-registry.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useUiStore } from "./ui.ts";

const disposeTerminal = (instance: TerminalInstance): void => {
	void import("../lib/terminal-registry.ts").then((registry) =>
		registry.dispose(instance.environmentId, instance.id, {
			serverPtyId: instance.serverPtyId,
			ownerId: instance.ownerId,
		}),
	);
};

const reconcileTerminalBinding = (
	environmentId: EnvironmentId,
	instanceId: PtyId,
	serverPtyId: PtyId,
	processEpoch: string,
): void => {
	void import("../lib/terminal-registry.ts").then((registry) =>
		registry.reconcilePtyBinding(
			environmentId,
			instanceId,
			serverPtyId,
			processEpoch,
		),
	);
};

type ExplicitCloseTombstone = Readonly<{
	environmentId: EnvironmentId;
	ownerId: PtyOwnerId;
	ptyId: PtyId;
}>;

type TerminalOwnerCatalog = Readonly<{
	environmentId: EnvironmentId;
	ownerId: PtyOwnerId;
	liveLimit: number | null;
	/** Server-authoritative live processes at the last catalog revision. */
	runningPtyIds: ReadonlySet<PtyId>;
}>;

// Catalog confirmation normally prunes these immediately. The cap protects a
// long-running renderer when owners are archived and never queried again.
const MAX_EXPLICIT_CLOSE_TOMBSTONES = 2_048;
const explicitlyClosedServerPtys = new Map<string, ExplicitCloseTombstone>();
const serverPtyKey = (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
	ptyId: PtyId,
): string => structuralTupleKey(environmentId, ownerId, ptyId);
const terminalOwnerCatalogKey = (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): string => structuralTupleKey(environmentId, ownerId);

const markExplicitlyClosed = (instance: TerminalInstance): void => {
	if (instance.serverPtyId === undefined) return;
	const tombstone: ExplicitCloseTombstone = {
		environmentId: instance.environmentId,
		ownerId: instance.ownerId,
		ptyId: instance.serverPtyId,
	};
	const key = serverPtyKey(
		tombstone.environmentId,
		tombstone.ownerId,
		tombstone.ptyId,
	);
	// Refresh insertion order so the fallback bound evicts the oldest closure.
	explicitlyClosedServerPtys.delete(key);
	explicitlyClosedServerPtys.set(key, tombstone);
	while (explicitlyClosedServerPtys.size > MAX_EXPLICIT_CLOSE_TOMBSTONES) {
		const oldest = explicitlyClosedServerPtys.keys().next().value;
		if (oldest === undefined) break;
		explicitlyClosedServerPtys.delete(oldest);
	}
};

const reconcileExplicitCloseTombstones = (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
	summaries: ReadonlyArray<PtySummary>,
): void => {
	const present = new Set(summaries.map((summary) => summary.ptyId));
	for (const [key, tombstone] of explicitlyClosedServerPtys) {
		if (
			tombstone.environmentId === environmentId &&
			tombstone.ownerId === ownerId &&
			!present.has(tombstone.ptyId)
		) {
			explicitlyClosedServerPtys.delete(key);
		}
	}
};

/**
 * Renderer-side terminal instances. The Ghostty surface + PTY live in
 * `terminal-registry.ts` (kept alive across chat switches); this store only
 * tracks the list of slots each chat wants to see.
 * Server-owned PTYs are reconciled by `terminal-catalog.ts` after a renderer
 * reload, while pending renderer-only slots remain intact.
 *
 * Keyed by an explicit `ChatRef` so equal chat ids on different computers can
 * never share or tear down each other's shells. Closing a terminal, or its
 * owning chat, disposes the backing PTY via the registry.
 */
export type TerminalInstance = {
	readonly environmentId: EnvironmentId;
	readonly id: PtyId;
	readonly ownerId: PtyOwnerId;
	readonly serverPtyId?: PtyId;
	readonly processEpoch?: string;
	/** Last authoritative process state; absent while a local open is reserved. */
	readonly status?: PtySummary["status"];
	/** Newer retained-runtime evidence for the same logical terminal. */
	readonly runtimeStatus?: TerminalRuntimeStatus;
	readonly title: string;
	readonly cwd: string;
	readonly command?: {
		readonly cmd: string;
		readonly args: ReadonlyArray<string>;
		readonly env?: Readonly<Record<string, string>>;
	};
};

/**
 * Renderer placement is part of a terminal collection's identity. Keeping the
 * established right-dock key unchanged avoids disturbing existing shells,
 * while the bottom dock gets an independent list and therefore independent
 * PTYs for the same chat.
 */
export type TerminalPlacement = "right" | "bottom";

type TerminalsState = {
	readonly byKey: Readonly<Record<string, ReadonlyArray<TerminalInstance>>>;
	readonly ownerCatalogsByKey: Readonly<Record<string, TerminalOwnerCatalog>>;
	/**
	 * Resolve a 0-based slot index to a terminal instance for `key`, appending
	 * fresh instances until the list is long enough. Used by the right-dock
	 * terminal tabs, which carry a workspace-relative `slot` rather than a
	 * pinned instance id (see `ui.ts` PanelInstance). Returns the instance at
	 * `slot`.
	 */
	readonly ensureSlot: (
		ref: ChatRef,
		slot: number,
		cwd: string,
		placement?: TerminalPlacement,
	) => TerminalInstance;
	/**
	 * Append a command-bound terminal instance and return its 0-based LIST
	 * INDEX (not its id), so the caller can pin a right-dock terminal panel to
	 * exactly that slot (see `lib/run-terminal.ts`).
	 */
	readonly add: (
		ref: ChatRef,
		environmentId: EnvironmentId,
		cwd: string,
		title: string,
		command?: TerminalInstance["command"],
		placement?: TerminalPlacement,
	) => number;
	readonly remove: (
		ref: ChatRef,
		id: PtyId,
		placement?: TerminalPlacement,
	) => void;
	readonly reconcileOwned: (
		ref: ChatRef,
		environmentId: EnvironmentId,
		placement: TerminalPlacement,
		catalog: TerminalCatalog,
	) => void;
	readonly bindPty: (
		ref: ChatRef,
		id: PtyId,
		placement: TerminalPlacement,
		serverPtyId: PtyId,
		processEpoch: string,
	) => void;
	readonly rename: (
		ref: ChatRef,
		id: PtyId,
		placement: TerminalPlacement,
		title: string,
	) => void;
	readonly observeRuntimeStatus: (
		ref: ChatRef,
		id: PtyId,
		placement: TerminalPlacement,
		status: TerminalRuntimeStatus,
	) => void;
	/**
	 * Dispose every terminal owned by a chat (closing each backing PTY) and drop
	 * the chat's list. Called when a chat is archived or deleted so its shells
	 * don't leak.
	 */
	readonly disposeChat: (ref: ChatRef) => void;
};

export const terminalsKey = (
	ref: ChatRef,
	placement: TerminalPlacement = "right",
): string =>
	placement === "right"
		? resourceRefKey(ref)
		: `${resourceRefKey(ref)}:terminal:bottom`;

export const terminalOwnerId = (
	ref: ChatRef,
	placement: TerminalPlacement,
): PtyOwnerId =>
	PtyOwnerId.make(`desktop-terminal:${resourceRefKey(ref)}:${placement}`);

export const terminalOwnerCleanupTargets = (
	ref: ChatRef,
	localEnvironmentId: EnvironmentId,
): ReadonlyArray<
	Readonly<{ environmentId: EnvironmentId; ownerId: PtyOwnerId }>
> => {
	const environments =
		ref.environmentId === localEnvironmentId
			? [ref.environmentId]
			: [ref.environmentId, localEnvironmentId];
	return environments.flatMap((environmentId) =>
		(["right", "bottom"] as const).map((placement) => ({
			environmentId,
			ownerId: terminalOwnerId(ref, placement),
		})),
	);
};

const closeOwnedTerminalsForChat = (ref: ChatRef): void => {
	void Promise.all([
		import("../lib/terminal-client-bus.ts"),
		import("../lib/rpc-client.ts"),
	])
		.then(async ([terminalClient, rpcClient]) => {
			const targets = terminalOwnerCleanupTargets(
				ref,
				EnvironmentId.make(rpcClient.getLocalEnvironmentId()),
			);
			await Promise.allSettled(
				targets.map((target) =>
					terminalClient.dispatchTerminalCloseOwned(
						target.environmentId,
						target.ownerId,
					),
				),
			);
		})
		.catch(() => undefined);
};

const newId = (): PtyId =>
	PtyId.make(
		globalThis.crypto?.randomUUID?.() ??
			`t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
	);

const nextTitle = (existing: ReadonlyArray<TerminalInstance>): string => {
	if (existing.length === 0) return "zsh";
	// "zsh", "zsh 2", "zsh 3" — skip numbers already in use so closing the
	// middle one and adding again reuses the gap rather than racing past it.
	const used = new Set(existing.map((t) => t.title));
	for (let n = 2; n < 1000; n++) {
		const candidate = `zsh ${n}`;
		if (!used.has(candidate)) return candidate;
	}
	return `zsh ${existing.length + 1}`;
};

export const useTerminalsStore = create<TerminalsState>((set) => ({
	byKey: {},
	ownerCatalogsByKey: {},
	ensureSlot: (ref, slot, cwd, placement = "right") => {
		const key = terminalsKey(ref, placement);
		let result: TerminalInstance | undefined;
		set((state) => {
			const list = state.byKey[key] ?? [];
			if (list.length > slot) {
				const existing = list[slot] as TerminalInstance;
				result = existing;
				return state;
			}
			const next = [...list];
			while (next.length <= slot) {
				next.push({
					environmentId: ref.environmentId,
					id: newId(),
					ownerId: terminalOwnerId(ref, placement),
					title: nextTitle(next),
					cwd,
				});
			}
			const instance = next[slot] as TerminalInstance;
			result = instance;
			return { byKey: { ...state.byKey, [key]: next } };
		});
		return result as TerminalInstance;
	},
	add: (ref, environmentId, cwd, title, command, placement = "right") => {
		const key = terminalsKey(ref, placement);
		const id = newId();
		let index = 0;
		set((state) => {
			const list = state.byKey[key] ?? [];
			index = list.length;
			const instance: TerminalInstance = {
				environmentId,
				id,
				ownerId: terminalOwnerId(ref, placement),
				title,
				cwd,
				command,
			};
			return { byKey: { ...state.byKey, [key]: [...list, instance] } };
		});
		return index;
	},
	remove: (ref, id, placement = "right") =>
		set((state) => {
			const key = terminalsKey(ref, placement);
			const list = state.byKey[key] ?? [];
			const idx = list.findIndex((t) => t.id === id);
			if (idx === -1) return state;
			// Component unmount no longer kills the PTY (it only detaches), so an
			// explicit close has to tear the backing shell down here.
			const instance = list[idx];
			if (instance === undefined) return state;
			markExplicitlyClosed(instance);
			disposeTerminal(instance);
			const next = list.filter((t) => t.id !== id);
			const ownerCatalogKey = terminalOwnerCatalogKey(
				instance.environmentId,
				instance.ownerId,
			);
			const ownerCatalog = state.ownerCatalogsByKey[ownerCatalogKey];
			if (instance.serverPtyId === undefined || ownerCatalog === undefined) {
				return { byKey: { ...state.byKey, [key]: next } };
			}
			const runningPtyIds = new Set(ownerCatalog.runningPtyIds);
			if (!runningPtyIds.delete(instance.serverPtyId)) {
				return { byKey: { ...state.byKey, [key]: next } };
			}
			return {
				byKey: { ...state.byKey, [key]: next },
				ownerCatalogsByKey: {
					...state.ownerCatalogsByKey,
					[ownerCatalogKey]: { ...ownerCatalog, runningPtyIds },
				},
			};
		}),
	reconcileOwned: (ref, environmentId, placement, catalog) => {
		const removedSlots: number[] = [];
		set((state) => {
			const key = terminalsKey(ref, placement);
			const ownerId = terminalOwnerId(ref, placement);
			const summaries = catalog.terminals;
			const authoritative = summaries.filter(
				(summary) =>
					!explicitlyClosedServerPtys.has(
						serverPtyKey(environmentId, ownerId, summary.ptyId),
					),
			);
			reconcileExplicitCloseTombstones(environmentId, ownerId, summaries);
			const summaryIds = new Set(authoritative.map((summary) => summary.ptyId));
			const current = state.byKey[key] ?? [];
			for (const [slot, instance] of current.entries()) {
				if (
					instance.environmentId === environmentId &&
					instance.serverPtyId !== undefined &&
					!summaryIds.has(instance.serverPtyId)
				) {
					removedSlots.push(slot);
					disposeTerminal(instance);
				}
			}
			const next = [...current].filter(
				(instance) =>
					instance.environmentId !== environmentId ||
					instance.serverPtyId === undefined ||
					summaryIds.has(instance.serverPtyId),
			);
			for (const summary of authoritative) {
				let index = next.findIndex(
					(instance) =>
						instance.environmentId === environmentId &&
						instance.serverPtyId === summary.ptyId,
				);
				let reconciledLogicalOpen = false;
				if (index < 0 && summary.openToken !== null) {
					index = next.findIndex(
						(instance) =>
							instance.environmentId === environmentId &&
							instance.serverPtyId === undefined &&
							String(instance.id) === String(summary.openToken),
					);
					reconciledLogicalOpen = index >= 0;
				}
				if (index >= 0) {
					const current = next[index] as TerminalInstance;
					next[index] = {
						...current,
						cwd: summary.cwd,
						serverPtyId: summary.ptyId,
						processEpoch: summary.processEpoch,
						status: summary.status,
						runtimeStatus:
							current.processEpoch === summary.processEpoch
								? current.runtimeStatus
								: undefined,
						title: summary.label ?? current.title,
					};
					if (reconciledLogicalOpen) {
						reconcileTerminalBinding(
							environmentId,
							current.id,
							summary.ptyId,
							summary.processEpoch,
						);
					}
					continue;
				}
				next.push({
					environmentId,
					id:
						summary.openToken === null
							? summary.ptyId
							: PtyId.make(summary.openToken),
					ownerId,
					serverPtyId: summary.ptyId,
					processEpoch: summary.processEpoch,
					status: summary.status,
					title: summary.label ?? nextTitle(next),
					cwd: summary.cwd,
				});
			}
			const ownerCatalogKey = terminalOwnerCatalogKey(environmentId, ownerId);
			return {
				byKey: { ...state.byKey, [key]: next },
				ownerCatalogsByKey: {
					...state.ownerCatalogsByKey,
					[ownerCatalogKey]: {
						environmentId,
						ownerId,
						liveLimit: catalog.liveLimit,
						runningPtyIds: new Set(
							authoritative
								.filter((summary) => summary.status === "running")
								.map((summary) => summary.ptyId),
						),
					},
				},
			};
		});
		if (placement === "right" && removedSlots.length > 0) {
			useUiStore.getState().reconcileTerminalPanelSlots(ref, removedSlots);
		}
	},
	bindPty: (ref, id, placement, serverPtyId, processEpoch) =>
		set((state) => {
			const key = terminalsKey(ref, placement);
			const list = state.byKey[key] ?? [];
			const next = list.map((instance) =>
				instance.id === id
					? {
							...instance,
							serverPtyId,
							processEpoch,
							status: "running" as const,
						}
					: instance,
			);
			return next.every((instance, index) => instance === list[index])
				? state
				: { byKey: { ...state.byKey, [key]: next } };
		}),
	rename: (ref, id, placement, title) =>
		set((state) => {
			const key = terminalsKey(ref, placement);
			const list = state.byKey[key] ?? [];
			const next = list.map((instance) =>
				instance.id === id && instance.title !== title
					? { ...instance, title }
					: instance,
			);
			return next.every((instance, index) => instance === list[index])
				? state
				: { byKey: { ...state.byKey, [key]: next } };
		}),
	observeRuntimeStatus: (ref, id, placement, status) =>
		set((state) => {
			const key = terminalsKey(ref, placement);
			const list = state.byKey[key] ?? [];
			const next = list.map((instance) =>
				instance.id === id && instance.runtimeStatus !== status
					? { ...instance, runtimeStatus: status }
					: instance,
			);
			return next.every((instance, index) => instance === list[index])
				? state
				: { byKey: { ...state.byKey, [key]: next } };
		}),
	disposeChat: (ref) => {
		// Owners are deterministic, so cleanup does not depend on a mounted view,
		// a hydrated catalog, or even a surviving cloud directory entry.
		closeOwnedTerminalsForChat(ref);
		set((state) => {
			const keys = [
				terminalsKey(ref, "right"),
				terminalsKey(ref, "bottom"),
			] as const;
			const ownerIds = new Set([
				terminalOwnerId(ref, "right"),
				terminalOwnerId(ref, "bottom"),
			]);
			const hasTerminals = keys.some((key) => Object.hasOwn(state.byKey, key));
			const hasCatalog = Object.values(state.ownerCatalogsByKey).some(
				(catalog) => ownerIds.has(catalog.ownerId),
			);
			if (!hasTerminals && !hasCatalog) return state;
			const lists = keys.flatMap((key) => state.byKey[key] ?? []);
			for (const inst of lists) {
				markExplicitlyClosed(inst);
				disposeTerminal(inst);
			}
			const byKey = { ...state.byKey };
			for (const key of keys) delete byKey[key];
			const ownerCatalogsByKey = Object.fromEntries(
				Object.entries(state.ownerCatalogsByKey).filter(
					([, catalog]) => !ownerIds.has(catalog.ownerId),
				),
			);
			return { byKey, ownerCatalogsByKey };
		});
	},
}));

export const terminalOwnerLiveLimit = (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): number | null =>
	useTerminalsStore.getState().ownerCatalogsByKey[
		terminalOwnerCatalogKey(environmentId, ownerId)
	]?.liveLimit ?? null;

export const terminalOwnerOccupancy = (
	terminals: ReadonlyArray<TerminalInstance>,
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): Readonly<{ liveLimit: number | null; occupied: number }> => {
	const catalog =
		useTerminalsStore.getState().ownerCatalogsByKey[
			terminalOwnerCatalogKey(environmentId, ownerId)
		];
	const runningPtyIds = new Set(catalog?.runningPtyIds ?? []);
	let pendingReservations = 0;
	for (const terminal of terminals) {
		if (
			terminal.environmentId !== environmentId ||
			terminal.ownerId !== ownerId
		) {
			continue;
		}
		if (terminal.serverPtyId === undefined) {
			pendingReservations += 1;
		} else if (terminal.runtimeStatus === "exited") {
			runningPtyIds.delete(terminal.serverPtyId);
		} else if (
			terminal.runtimeStatus !== undefined ||
			terminal.status === "running"
		) {
			// Connecting, reconnecting, and failed are conservative: until an exit
			// event or catalog proves otherwise, the server may still own the slot.
			runningPtyIds.add(terminal.serverPtyId);
		}
	}
	return {
		liveLimit: catalog?.liveLimit ?? null,
		occupied: runningPtyIds.size + pendingReservations,
	};
};

export const EMPTY_TERMINALS: ReadonlyArray<TerminalInstance> = [];
