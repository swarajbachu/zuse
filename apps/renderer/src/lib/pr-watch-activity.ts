import type { PrWatch } from "../store/pr-watch.ts";

/** Cleanup from an older repair must not release a resumed generation. */
export function createPrWatchActivity() {
	const active = new Map<string, PrWatch["generation"]>();
	return {
		has: (watch: Pick<PrWatch, "id" | "generation">) =>
			active.has(watch.id) && active.get(watch.id) === watch.generation,
		begin: (watch: Pick<PrWatch, "id" | "generation">) => {
			active.set(watch.id, watch.generation);
			return () => {
				if (active.has(watch.id) && active.get(watch.id) === watch.generation)
					active.delete(watch.id);
			};
		},
	};
}
