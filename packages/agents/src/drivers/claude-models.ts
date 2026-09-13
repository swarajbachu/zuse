import {
	type Options,
	query,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
	applyClaudeCredentialEnv,
	type ClaudeManagedCredential,
} from "./claude.ts";

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
export const listClaudeModels = async (args: {
	readonly claudeExecutablePath: string | null;
	readonly credential: ClaudeManagedCredential | null;
	readonly cwd: string;
	readonly timeoutMs: number;
}): Promise<ReadonlyArray<ClaudeListedModel>> => {
	const abort = new AbortController();
	let release = (): void => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const idle: AsyncIterable<SDKUserMessage> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				await released;
				return { done: true, value: undefined as never };
			},
		}),
	};
	const options: Options = {
		cwd: args.cwd,
		abortController: abort,
		env: applyClaudeCredentialEnv(process.env, args.credential) as Record<
			string,
			string | undefined
		>,
		maxTurns: 1,
		persistSession: false,
		tools: [],
		...(args.claudeExecutablePath !== null
			? { pathToClaudeCodeExecutable: args.claudeExecutablePath }
			: {}),
	};
	const timer = setTimeout(() => abort.abort(), args.timeoutMs);
	const q = query({ prompt: idle, options });
	try {
		const models = await Promise.race([
			q.supportedModels(),
			new Promise<never>((_, reject) => {
				abort.signal.addEventListener("abort", () =>
					reject(new Error("Claude model listing timed out.")),
				);
			}),
		]);
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
	} finally {
		clearTimeout(timer);
		release();
		try {
			q.close();
		} catch {
			// process already gone
		}
	}
};
