import { childProcessEnv } from "@zuse/utils/process-env";

export type AccountProvider = "claude" | "codex";

/** Native CLIs own login and renewal within these account-specific homes. */
export const providerAccountEnv = (
	provider: AccountProvider,
	home: string,
): Record<string, string> =>
	provider === "claude"
		? { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home }
		: { CODEX_HOME: home };

export const providerAccountUnsetEnv = (
	provider: AccountProvider,
): readonly string[] =>
	provider === "claude"
		? [
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_AUTH_TOKEN",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
				"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
				"CLAUDE_CODE_USE_BEDROCK",
				"CLAUDE_CODE_USE_VERTEX",
				"CLAUDE_CODE_USE_FOUNDRY",
			]
		: [
				"OPENAI_API_KEY",
				"CODEX_API_KEY",
				"CODEX_ACCESS_TOKEN",
				"CODEX_AUTH_JSON",
				"CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
			];

export const isolatedProviderAccountEnv = (
	provider: AccountProvider,
	home: string,
	base: NodeJS.ProcessEnv,
) =>
	childProcessEnv(
		base,
		providerAccountEnv(provider, home),
		providerAccountUnsetEnv(provider),
	);
