import { useCallback, useState } from "react";
import { createAtomStore } from "../state/atom-store.ts";

/**
 * The last "toggle all" press. Rows without a per-key override follow `open`;
 * `epoch` lets keyless rows tell their own click apart from a later bulk
 * press without effects or subscriptions to anything but this object.
 */
export interface BulkDisclosure {
	readonly open: boolean;
	readonly epoch: number;
}

const MAX_KEYS = 2048;

/** Bounded UI state survives virtualized row remounts without touching transcripts. */
export const useTranscriptDisclosures = createAtomStore<{
	readonly byKey: Readonly<Record<string, boolean>>;
	readonly bulk: BulkDisclosure | null;
	readonly toggle: (key: string, defaultOpen: boolean) => void;
	/** Expands every transcript disclosure, or collapses them all when the last press expanded. */
	readonly toggleAll: () => void;
}>((set, get) => ({
	byKey: {},
	bulk: null,
	toggle: (key, defaultOpen) => {
		const { byKey: previous, bulk } = get();
		const entries = Object.entries(previous).filter(([entry]) => entry !== key);
		set({
			byKey: Object.fromEntries([
				...entries.slice(-(MAX_KEYS - 1)),
				[key, !(previous[key] ?? bulk?.open ?? defaultOpen)],
			]),
		});
	},
	toggleAll: () => {
		const { bulk } = get();
		// Per-key overrides are dropped so every row follows the new bulk state.
		set({
			byKey: {},
			bulk: { open: !(bulk?.open ?? false), epoch: (bulk?.epoch ?? 0) + 1 },
		});
	},
}));

/**
 * Disclosure state for a row with a stable key. The third element reports
 * whether the current value came from "toggle all", so rows can skip their
 * open/close animation when hundreds of them change in the same frame.
 */
export function useTranscriptDisclosure(key: string, defaultOpen = false) {
	const open = useTranscriptDisclosures(
		(state) => state.byKey[key] ?? state.bulk?.open ?? defaultOpen,
	);
	const viaBulk = useTranscriptDisclosures(
		(state) => state.byKey[key] === undefined && state.bulk !== null,
	);
	return [
		open,
		() => useTranscriptDisclosures.getState().toggle(key, defaultOpen),
		viaBulk,
	] as const;
}

/**
 * Disclosure state for a row without a stable key. The value is local to the
 * mounted row, yet a "toggle all" press still wins over any earlier click.
 * Same tuple shape as {@link useTranscriptDisclosure}.
 */
export function useLocalTranscriptDisclosure(defaultOpen = false) {
	const bulk = useTranscriptDisclosures((state) => state.bulk);
	const [own, setOwn] = useState<BulkDisclosure | null>(null);
	const toggle = useCallback(
		() =>
			setOwn((previous) =>
				nextLocalDisclosure(
					previous,
					useTranscriptDisclosures.getState().bulk,
					defaultOpen,
				),
			),
		[defaultOpen],
	);
	const { open, viaBulk } = resolveLocalDisclosure(own, bulk, defaultOpen);
	return [open, toggle, viaBulk] as const;
}

/** A row's own click only counts while it is newer than the last bulk press. */
export function resolveLocalDisclosure(
	own: BulkDisclosure | null,
	bulk: BulkDisclosure | null,
	defaultOpen: boolean,
): { readonly open: boolean; readonly viaBulk: boolean } {
	return bulk !== null && (own === null || own.epoch !== bulk.epoch)
		? { open: bulk.open, viaBulk: true }
		: { open: own?.open ?? defaultOpen, viaBulk: false };
}

export function nextLocalDisclosure(
	own: BulkDisclosure | null,
	bulk: BulkDisclosure | null,
	defaultOpen: boolean,
): BulkDisclosure {
	return {
		epoch: bulk?.epoch ?? 0,
		open: !resolveLocalDisclosure(own, bulk, defaultOpen).open,
	};
}
