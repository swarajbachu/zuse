import type { PokemonCatalogEntry } from "@zuse/pokemon-data";
import { describe, expect, it } from "vitest";
import {
	allocatePokemonName,
	type PokemonNameAllocatorInput,
} from "../../src/pokemon/allocator.ts";

const catalog = [
	{
		number: 1,
		slug: "bulbasaur",
		name: "Bulbasaur",
		generation: 1,
		familyId: 1,
		rarity: "common",
		points: 10,
		spriteUrl: "https://example.com/bulbasaur.png",
	},
	{
		number: 2,
		slug: "ivysaur",
		name: "Ivysaur",
		generation: 1,
		familyId: 1,
		rarity: "uncommon",
		points: 25,
		spriteUrl: "https://example.com/ivysaur.png",
	},
	{
		number: 3,
		slug: "venusaur",
		name: "Venusaur",
		generation: 1,
		familyId: 1,
		rarity: "rare",
		points: 75,
		spriteUrl: "https://example.com/venusaur.png",
	},
] as const satisfies readonly PokemonCatalogEntry[];

const allocate = (patch: Partial<PokemonNameAllocatorInput>) =>
	allocatePokemonName({
		catalog,
		unavailableNames: new Set(),
		usedPokemonNumbers: new Set(),
		random: () => 0.99,
		...patch,
	});

describe("allocatePokemonName", () => {
	it("uses the bare species name first", () => {
		expect(allocate({})?.name).toBe("bulbasaur");
	});

	it("does not unlock an evolved form before the base species", () => {
		const result = allocate({ random: () => 0 });
		expect(result?.name).toBe("bulbasaur");
		expect(result?.pokemon.number).toBe(1);
	});

	it("tries unused evolutions after the base species is unlocked", () => {
		const result = allocate({
			unavailableNames: new Set(["bulbasaur"]),
			usedPokemonNumbers: new Set([1]),
		});
		expect(result?.name).toBe("ivysaur");
		expect(result?.pokemon.number).toBe(2);
	});

	it("falls back to vN when the evolution line is exhausted", () => {
		const result = allocate({
			unavailableNames: new Set(["bulbasaur", "ivysaur", "venusaur"]),
			usedPokemonNumbers: new Set([1, 2, 3]),
		});
		expect(result?.name).toBe("bulbasaur-v2");
		expect(result?.pokemon.number).toBe(1);
	});
});
