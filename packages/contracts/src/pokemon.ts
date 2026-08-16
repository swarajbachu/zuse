import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { WorktreeId } from "./ids.ts";

export const PokemonRarity = Schema.Literals([
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
]);
export type PokemonRarity = typeof PokemonRarity.Type;

export class PokemonSummary extends Schema.Class<PokemonSummary>(
  "PokemonSummary",
)({
  number: Schema.Number,
  slug: Schema.String,
  name: Schema.String,
  generation: Schema.Number,
  rarity: PokemonRarity,
  points: Schema.Number,
  spriteUrl: Schema.NullOr(Schema.String),
}) {}

export class PokemonSpriteVariant extends Schema.Class<PokemonSpriteVariant>(
  "PokemonSpriteVariant",
)({
  id: Schema.String,
  label: Schema.String,
  spriteUrl: Schema.NullOr(Schema.String),
}) {}

export class PokemonEvolutionStep extends Schema.Class<PokemonEvolutionStep>(
  "PokemonEvolutionStep",
)({
  number: Schema.Number,
  slug: Schema.String,
  name: Schema.String,
  rarity: PokemonRarity,
  unlocked: Schema.Boolean,
  spriteUrl: Schema.NullOr(Schema.String),
  silhouetteUrl: Schema.String,
}) {}

export class PokemonPokedexEntry extends Schema.Class<PokemonPokedexEntry>(
  "PokemonPokedexEntry",
)({
  number: Schema.Number,
  slug: Schema.String,
  name: Schema.String,
  generation: Schema.Number,
  rarity: PokemonRarity,
  points: Schema.Number,
  unlocked: Schema.Boolean,
  unlockedAt: Schema.NullOr(Schema.DateFromString),
  worktreeId: Schema.NullOr(WorktreeId),
  spriteUrl: Schema.NullOr(Schema.String),
  silhouetteUrl: Schema.String,
  variants: Schema.Array(PokemonSpriteVariant),
  evolutionLine: Schema.Array(PokemonEvolutionStep),
}) {}

export class PokemonNotFoundError extends Schema.TaggedErrorClass<PokemonNotFoundError>()(
  "PokemonNotFoundError",
  { number: Schema.Number },
) {}

export const PokemonPokedexRpc = Rpc.make("pokemon.pokedex", {
  payload: Schema.Struct({}),
  success: Schema.Array(PokemonPokedexEntry),
});

export const PokemonEnsureSpriteCachedRpc = Rpc.make(
  "pokemon.ensureSpriteCached",
  {
    payload: Schema.Struct({ number: Schema.Number }),
    success: PokemonPokedexEntry,
    error: PokemonNotFoundError,
  },
);
