import {
	type ClaudeControlOptions,
	withClaudeControlClient,
} from "./claude-control-client.ts";

export interface ClaudeListedModel {
	readonly id: string;
	readonly label: string;
	readonly description: string | null;
	readonly effortLevels: ReadonlyArray<string> | null;
	readonly supportsFastMode: boolean | null;
}

/**
 * Ask Claude Code which models the current login can use. The SDK only
 * answers on a live query, so this starts a throwaway session with an input
 * channel that never yields a prompt, reads `supportedModels()`, and closes
 * the process. Not authoritative: Claude Code reports a curated list that
 * may lag the API, so the catalog only *adds* from it.
 */
export const listClaudeModels = async (
	args: ClaudeControlOptions,
): Promise<ReadonlyArray<ClaudeListedModel>> =>
	withClaudeControlClient(args, async (q) => {
		const models = await q.supportedModels();
		return models.map((model) => ({
			id: model.value,
			label: model.displayName,
			description:
				typeof model.description === "string" && model.description.length > 0
					? model.description
					: null,
			effortLevels:
				model.supportsEffort === true &&
				Array.isArray(model.supportedEffortLevels)
					? model.supportedEffortLevels
					: null,
			supportsFastMode:
				typeof model.supportsFastMode === "boolean"
					? model.supportsFastMode
					: null,
		}));
	});
