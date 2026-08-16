import {
	type ChatRef,
	resourceRefKey,
} from "@zuse/client-runtime/resource-ref";
import { type EnvironmentId, PtyId } from "@zuse/contracts";
import { createAtomStore as create } from "../state/atom-store.ts";

const disposeTerminal = (environmentId: EnvironmentId, id: PtyId): void => {
	void import("../lib/terminal-registry.ts").then((registry) =>
		registry.dispose(environmentId, id),
	);
};

/**
 * Renderer-side terminal instances. The xterm + PTY themselves live in
 * `terminal-registry.ts` (kept alive across chat switches); this store only
 * tracks the list of slots each chat wants to see.
 * PTYs die with the renderer (no rehydration across reloads).
 *
 * Keyed by an explicit `ChatRef` so equal chat ids on different computers can
 * never share or tear down each other's shells. Closing a terminal, or its
 * owning chat, disposes the backing PTY via the registry.
 */
export type TerminalInstance = {
	readonly environmentId: EnvironmentId;
	readonly id: PtyId;
	readonly title: string;
	readonly cwd: string;
	readonly command?: {
		readonly cmd: string;
		readonly args: ReadonlyArray<string>;
		readonly env?: Readonly<Record<string, string>>;
	};
};

type TerminalsState = {
	readonly byKey: Readonly<Record<string, ReadonlyArray<TerminalInstance>>>;
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
	) => number;
	readonly remove: (ref: ChatRef, id: PtyId) => void;
	/**
	 * Dispose every terminal owned by a chat (closing each backing PTY) and drop
	 * the chat's list. Called when a chat is archived or deleted so its shells
	 * don't leak.
	 */
	readonly disposeChat: (ref: ChatRef) => void;
};

export const terminalsKey = (ref: ChatRef): string => resourceRefKey(ref);

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
	ensureSlot: (ref, slot, cwd) => {
		const key = terminalsKey(ref);
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
	add: (ref, environmentId, cwd, title, command) => {
		const key = terminalsKey(ref);
		const id = newId();
		let index = 0;
		set((state) => {
			const list = state.byKey[key] ?? [];
			index = list.length;
			const instance: TerminalInstance = {
				environmentId,
				id,
				title,
				cwd,
				command,
			};
			return { byKey: { ...state.byKey, [key]: [...list, instance] } };
		});
		return index;
	},
	remove: (ref, id) =>
		set((state) => {
			const key = terminalsKey(ref);
			const list = state.byKey[key] ?? [];
			const idx = list.findIndex((t) => t.id === id);
			if (idx === -1) return state;
			// Component unmount no longer kills the PTY (it only detaches), so an
			// explicit close has to tear the backing shell down here.
			disposeTerminal(list[idx]?.environmentId ?? ref.environmentId, id);
			const next = list.filter((t) => t.id !== id);
			return { byKey: { ...state.byKey, [key]: next } };
		}),
	disposeChat: (ref) =>
		set((state) => {
			const key = terminalsKey(ref);
			const list = state.byKey[key];
			if (list === undefined) return state;
			for (const inst of list) disposeTerminal(inst.environmentId, inst.id);
			const { [key]: _droppedList, ...byKey } = state.byKey;
			return { byKey };
		}),
}));

export const EMPTY_TERMINALS: ReadonlyArray<TerminalInstance> = [];
