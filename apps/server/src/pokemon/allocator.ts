import type { PokemonCatalogEntry } from "@zuse/pokemon-data";

export interface PokemonNameAllocation {
  readonly pokemon: PokemonCatalogEntry;
  readonly name: string;
}

export interface PokemonNameAllocatorInput {
  readonly catalog: readonly PokemonCatalogEntry[];
  readonly unavailableNames: ReadonlySet<string>;
  readonly usedPokemonNumbers: ReadonlySet<number>;
  readonly random?: () => number;
}

const shuffleFromRandom = <T>(
  values: readonly T[],
  random: () => number,
): readonly T[] => {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
};

const familyFor = (
  catalog: readonly PokemonCatalogEntry[],
  pokemon: PokemonCatalogEntry,
): readonly PokemonCatalogEntry[] => {
  return catalog
    .filter((entry) => entry.familyId === pokemon.familyId)
    .sort((a, b) => a.number - b.number);
};

export const allocatePokemonName = ({
  catalog,
  unavailableNames,
  usedPokemonNumbers,
  random = Math.random,
}: PokemonNameAllocatorInput): PokemonNameAllocation | null => {
  const seeds = shuffleFromRandom(catalog, random);

  for (const seed of seeds) {
    for (const candidate of familyFor(catalog, seed)) {
      if (usedPokemonNumbers.has(candidate.number)) continue;
      if (unavailableNames.has(candidate.slug)) continue;
      return { pokemon: candidate, name: candidate.slug };
    }
  }

  for (const seed of seeds) {
    for (let version = 2; version < 10_000; version += 1) {
      const name = `${seed.slug}-v${version}`;
      if (unavailableNames.has(name)) continue;
      return { pokemon: seed, name };
    }
  }

  return null;
};
