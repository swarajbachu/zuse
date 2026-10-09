import { tmpdir } from "node:os";
import { Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { resolveCliPath } from "../../provider/availability.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { ProviderAccounts } from "../../provider/services/provider-accounts.ts";
import { fetchClaudeUsage } from "./claude-usage.ts";
import { fetchCodexUsage } from "./codex-usage.ts";
import type { UsageLimitFetchers } from "./service.ts";

/** Capture runtime services; resolve settings and credentials inside each isolated fetch. */
export const usageCliFetchers = Effect.gen(function* () {
	const config = yield* ConfigStoreService;
	const accounts = yield* Effect.serviceOption(ProviderAccounts);
	const accountHome = (provider: "claude" | "codex", signal: AbortSignal) =>
		Option.isSome(accounts)
			? Effect.runPromise(accounts.value.selected(provider), { signal }).then(
					(account) => account?.home,
				)
			: Promise.resolve(undefined);
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
			const home = await accountHome("claude", signal);
			const credential = home
				? null
				: await Effect.runPromise(credentials.getProviderCredential("claude"), {
						signal,
					});
			return fetchClaudeUsage({
				claudeExecutablePath,
				accountHome: home,
				credential,
				cwd: tmpdir(),
				timeoutMs: 15_000,
				signal,
			});
		},
		codex: async (signal) =>
			fetchCodexUsage(
				await path("codex", signal),
				signal,
				await accountHome("codex", signal),
			),
	} satisfies UsageLimitFetchers;
});
