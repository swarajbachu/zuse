import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import { mapCodexRateLimits } from "@zuse/agents/drivers/codex-usage-limits";
import type { ProviderUsageLimits } from "@zuse/contracts";
import { unavailable } from "./shared.ts";

export { mapCodexRateLimits };

export const fetchCodexUsage = async (
	codexPath: string | null,
	signal?: AbortSignal,
	accountHome?: string,
): Promise<ProviderUsageLimits> => {
	if (!codexPath) return unavailable("codex", "cli-unavailable");
	return withCodexControlClient(
		codexPath,
		async (client) => {
			// The shared client bounds startup separately. Give the read its full deadline.
			const requestSignal = AbortSignal.any([
				AbortSignal.timeout(5_000),
				...(signal ? [signal] : []),
			]);
			const result = await client.request<unknown>(
				"account/rateLimits/read",
				{},
				requestSignal,
			);
			if (
				!result ||
				typeof result !== "object" ||
				!("rateLimits" in result || "rateLimitsByLimitId" in result)
			)
				return unavailable("codex", "invalid-response");
			return mapCodexRateLimits(result);
		},
		accountHome,
	);
};
