import type { ChipRange } from "../lib/codemirror/composer-chips.ts";
import { createAtomStore } from "../state/atom-store.ts";

const STORAGE_KEY = "zuse.promptStash.v1";
export const MAX_STASHED_PROMPTS = 20;

export type StashedPrompt = {
	readonly id: string;
	readonly doc: string;
	readonly chips: readonly ChipRange[];
	readonly createdAt: number;
};

const isStashedPrompt = (value: unknown): value is StashedPrompt =>
	typeof value === "object" &&
	value !== null &&
	"id" in value &&
	typeof value.id === "string" &&
	"doc" in value &&
	typeof value.doc === "string" &&
	"chips" in value &&
	Array.isArray(value.chips) &&
	"createdAt" in value &&
	typeof value.createdAt === "number";

const load = (): readonly StashedPrompt[] => {
	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(STORAGE_KEY) ?? "[]",
		) as unknown;
		return Array.isArray(parsed)
			? parsed.filter(isStashedPrompt).slice(0, MAX_STASHED_PROMPTS)
			: [];
	} catch {
		return [];
	}
};

const persist = (entries: readonly StashedPrompt[]): void => {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {}
};

/** Image previews are blob URLs that die with the window; they rehydrate by id. */
const storableChips = (chips: readonly ChipRange[]): readonly ChipRange[] =>
	chips.map((chip) =>
		chip.meta.kind === "image"
			? { ...chip, meta: { ...chip.meta, previewUrl: "" } }
			: chip,
	);

/**
 * Prompts set aside with Ctrl+S, newest first. Shared by every composer and
 * kept across restarts so a parked idea is never lost.
 */
export const usePromptStash = createAtomStore<{
	readonly entries: readonly StashedPrompt[];
	readonly stash: (prompt: Pick<StashedPrompt, "doc" | "chips">) => void;
	readonly remove: (id: string) => void;
}>((set) => ({
	entries: typeof window === "undefined" ? [] : load(),
	stash: (prompt) =>
		set((state) => {
			const entries = [
				{
					id: crypto.randomUUID(),
					doc: prompt.doc,
					chips: storableChips(prompt.chips),
					createdAt: Date.now(),
				},
				...state.entries,
			].slice(0, MAX_STASHED_PROMPTS);
			persist(entries);
			return { entries };
		}),
	remove: (id) =>
		set((state) => {
			const entries = state.entries.filter((entry) => entry.id !== id);
			persist(entries);
			return { entries };
		}),
}));
