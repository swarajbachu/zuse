import { createAtomStore as create } from "../state/atom-store.ts";

import type { PokemonPokedexEntry } from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";

import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";

const spriteCacheRequests = new Set<number>();

const pokemonCommand = async <Payload, Result>(
	kind: string,
	payload: Payload,
): Promise<Result> => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	return (
		await dispatchEnvironmentShellCommand<Payload, Result>({
			environmentId,
			kind,
			commandId: CommandId.make(`pokemon:${crypto.randomUUID()}`),
			payload,
		})
	).result;
};

type PokemonState = {
	readonly entries: ReadonlyArray<PokemonPokedexEntry>;
	readonly loading: boolean;
	readonly error: string | null;
	readonly hydrate: () => Promise<void>;
	readonly ensureSpriteCached: (number: number) => Promise<void>;
};

const formatError = (err: unknown): string => {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && "_tag" in err) {
		return String((err as { _tag: unknown })._tag);
	}
	return String(err);
};

export const usePokemonStore = create<PokemonState>((set, get) => ({
	entries: [],
	loading: false,
	error: null,
	hydrate: async () => {
		set({ loading: true });
		try {
			const entries = await pokemonCommand<
				{},
				ReadonlyArray<PokemonPokedexEntry>
			>("pokemon.pokedex", {});
			set({ entries, loading: false, error: null });
		} catch (err) {
			set({ loading: false, error: formatError(err) });
		}
	},
	ensureSpriteCached: async (number) => {
		if (spriteCacheRequests.has(number)) return;
		spriteCacheRequests.add(number);
		try {
			const updated = await pokemonCommand<
				{ readonly number: number },
				PokemonPokedexEntry
			>("pokemon.ensureSpriteCached", { number });
			const entries = get().entries;
			set({
				entries: entries.map((entry) =>
					entry.number === updated.number ? updated : entry,
				),
				error: null,
			});
		} catch (err) {
			set({ error: formatError(err) });
		} finally {
			spriteCacheRequests.delete(number);
		}
	},
}));
