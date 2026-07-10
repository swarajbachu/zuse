import {
	PokemonAssignment,
	ProjectLocator,
	RepositorySettingsReader,
	WorktreeNameAllocator,
} from "@zuse/git/worktree-ports";
import { POKEMON_CATALOG } from "@zuse/pokemon-data";
import { Effect, Layer } from "effect";

import { allocatePokemonName } from "../pokemon/allocator.ts";
import { PokemonService } from "../pokemon/services/pokemon-service.ts";
import { RepositorySettingsService } from "../repository-settings/services/repository-settings-service.ts";
import { WorkspaceService } from "../workspace/services/workspace-service.ts";

export const ProjectLocatorLive = Layer.effect(
	ProjectLocator,
	Effect.gen(function* () {
		const workspace = yield* WorkspaceService;
		return ProjectLocator.of({
			find: (projectId) => workspace.findById(projectId),
		});
	}),
);

export const RepositorySettingsReaderLive = Layer.effect(
	RepositorySettingsReader,
	Effect.gen(function* () {
		const settings = yield* RepositorySettingsService;
		return RepositorySettingsReader.of({
			get: (projectId) =>
				settings.get(projectId).pipe(
					Effect.map((value) => ({
						worktreeBaseDir: value.worktreeBaseDir,
						setupScript: value.setupScript,
						runScript: value.runScript,
						environmentVariables: value.environmentVariables,
						fileIncludeGlobs: value.fileIncludeGlobs,
					})),
				),
		});
	}),
);

export const WorktreeNameAllocatorLive = Layer.succeed(
	WorktreeNameAllocator,
	WorktreeNameAllocator.of({
		allocate: ({ unavailableNames, usedPokemonNumbers }) =>
			Effect.sync(() => {
				const allocation = allocatePokemonName({
					catalog: POKEMON_CATALOG,
					unavailableNames,
					usedPokemonNumbers,
				});
				return allocation === null
					? null
					: {
							name: allocation.name,
							pokemonNumber: allocation.pokemon.number,
						};
			}),
	}),
);

export const PokemonAssignmentLive = Layer.effect(
	PokemonAssignment,
	Effect.gen(function* () {
		const pokemon = yield* PokemonService;
		return PokemonAssignment.of({ record: pokemon.recordUnlock });
	}),
);
