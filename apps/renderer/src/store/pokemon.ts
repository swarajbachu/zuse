import { Effect } from "effect";
import { create } from "zustand";

import type { PokemonPokedexEntry } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";

const spriteCacheRequests = new Set<number>();

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
      const client = await getRpcClient();
      const entries = await Effect.runPromise(client["pokemon.pokedex"]({}));
      set({ entries, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: formatError(err) });
    }
  },
  ensureSpriteCached: async (number) => {
    if (spriteCacheRequests.has(number)) return;
    spriteCacheRequests.add(number);
    try {
      const client = await getRpcClient();
      const updated = await Effect.runPromise(
        client["pokemon.ensureSpriteCached"]({ number }),
      );
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
