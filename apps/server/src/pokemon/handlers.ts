import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { PokemonService } from "./services/pokemon-service.ts";

const Pokedex = MemoizeRpcs.toLayerHandler("pokemon.pokedex", () =>
  Effect.flatMap(PokemonService, (svc) => svc.pokedex()),
);

const EnsureSpriteCached = MemoizeRpcs.toLayerHandler(
  "pokemon.ensureSpriteCached",
  ({ number }) =>
    Effect.flatMap(PokemonService, (svc) => svc.ensureSpriteCached(number)),
);

export const PokemonHandlersLayer = Layer.mergeAll(Pokedex, EnsureSpriteCached);
