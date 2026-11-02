import {
	ProjectLocator,
	RepositorySettingsReader,
	WorktreeNameAllocator,
} from "@zuse/git/worktree-ports";
import { Effect, Layer } from "effect";

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

const PLACEHOLDER_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A short neutral name such as `work-k3f9xq` for the folder, checked out on
 * `zuse/work-k3f9xq` until the chat's first turn names the branch.
 */
export const placeholderWorktreeName = (random: () => number = Math.random) =>
	`work-${Array.from(
		{ length: 6 },
		() =>
			PLACEHOLDER_ALPHABET[Math.floor(random() * PLACEHOLDER_ALPHABET.length)],
	).join("")}`;

export const placeholderBranch = (name: string) => `zuse/${name}`;

export const WorktreeNameAllocatorLive = Layer.succeed(
	WorktreeNameAllocator,
	WorktreeNameAllocator.of({
		allocate: ({ unavailableNames }) =>
			Effect.sync(() => {
				for (let attempt = 0; attempt < 100; attempt += 1) {
					const name = placeholderWorktreeName();
					const branch = placeholderBranch(name);
					if (!unavailableNames.has(name) && !unavailableNames.has(branch))
						return { name, branch };
				}
				return null;
			}),
	}),
);
