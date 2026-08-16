export interface PokemonNameCandidate {
	readonly number: number;
	readonly slug: string;
	readonly familyId: number;
}

export interface PokemonNameAllocation<T extends PokemonNameCandidate> {
	readonly pokemon: T;
	readonly name: string;
}

export interface PokemonNameAllocatorInput<
	T extends PokemonNameCandidate = PokemonNameCandidate,
> {
	readonly catalog: readonly T[];
	readonly unavailableNames: ReadonlySet<string>;
	readonly usedPokemonNumbers: ReadonlySet<number>;
	readonly random?: () => number;
}

export const allocatePokemonName = <T extends PokemonNameCandidate>({
	catalog,
	unavailableNames,
	usedPokemonNumbers,
	random = Math.random,
}: PokemonNameAllocatorInput<T>): PokemonNameAllocation<T> | null => {
	const seeds = [...catalog];
	for (let index = seeds.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		const current = seeds[index];
		const replacement = seeds[swap];
		if (current === undefined || replacement === undefined) continue;
		seeds[index] = replacement;
		seeds[swap] = current;
	}
	for (const seed of seeds) {
		for (const candidate of catalog
			.filter((entry) => entry.familyId === seed.familyId)
			.sort((left, right) => left.number - right.number)) {
			if (
				!usedPokemonNumbers.has(candidate.number) &&
				!unavailableNames.has(candidate.slug)
			)
				return { pokemon: candidate, name: candidate.slug };
		}
	}
	for (const seed of seeds) {
		for (let version = 2; version < 10_000; version += 1) {
			const name = `${seed.slug}-v${version}`;
			if (!unavailableNames.has(name)) return { pokemon: seed, name };
		}
	}
	return null;
};
