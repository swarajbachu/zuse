import type {
	PokemonNotFoundError,
	PokemonPokedexEntry,
	WorktreeId,
} from "@zuse/contracts";
import { Context, type Effect } from "effect";

export interface PokemonServiceShape {
	readonly pokedex: () => Effect.Effect<ReadonlyArray<PokemonPokedexEntry>>;
	readonly ensureSpriteCached: (
		number: number,
	) => Effect.Effect<PokemonPokedexEntry, PokemonNotFoundError>;
	readonly recordUnlock: (
		number: number,
		worktreeId: WorktreeId,
	) => Effect.Effect<void>;
}

export class PokemonService extends Context.Service<
	PokemonService,
	PokemonServiceShape
>()("memoize/PokemonService") {}
