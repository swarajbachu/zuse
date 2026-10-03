import { tmpdir } from "node:os";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { resolveCliPath } from "../../provider/availability.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { fetchClaudeUsage } from "./claude-usage.ts";
import { fetchCodexUsage } from "./codex-usage.ts";
import type { UsageLimitFetchers } from "./service.ts";

/** Capture runtime services; resolve settings and credentials inside each isolated fetch. */
export const usageCliFetchers = Effect.gen(function* () {
	const config = yield* ConfigStoreService;
	const credentials = yield* CredentialsService;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = (binary: string, signal: AbortSignal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const settings = yield* config.getSettings();
				return yield* resolveCliPath(
					binary,
					settings.providerBinaryPaths ?? {},
				);
			}).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			),
			{ signal },
		);
	return {
		claude: async (signal) => {
			const claudeExecutablePath = await path("claude", signal);
			const credential = await Effect.runPromise(
				credentials.getProviderCredential("claude"),
				{ signal },
			);
			return fetchClaudeUsage({
				claudeExecutablePath,
				credential,
				cwd: tmpdir(),
				timeoutMs: 15_000,
				signal,
			});
		},
		codex: async (signal) =>
			fetchCodexUsage(await path("codex", signal), signal),
	} satisfies UsageLimitFetchers;
});
