import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";

import { fetchClaudeUsage } from "./claude-usage.ts";
import { fetchCodexUsage } from "./codex-usage.ts";
import { fetchGeminiUsage } from "./gemini-usage.ts";
import { fetchGrokUsage } from "./grok-usage.ts";

const TTL = 60_000;
const FORCE_FLOOR = 10_000;
const fetchers: Record<
  "claude" | "codex" | "grok" | "gemini",
  () => Promise<ProviderUsageLimits>
> = {
  claude: fetchClaudeUsage,
  codex: fetchCodexUsage,
  grok: fetchGrokUsage,
  gemini: fetchGeminiUsage,
};
const cache = new Map<ProviderId, { at: number; value: ProviderUsageLimits }>();
const inFlight = new Map<ProviderId, Promise<ProviderUsageLimits>>();
const lastForcedAt = new Map<ProviderId, number>();

export const resetUsageLimitsCacheForTest = () => {
  cache.clear();
  inFlight.clear();
  lastForcedAt.clear();
};

const loadProvider = (
  providerId: keyof typeof fetchers,
  force: boolean,
  now: number,
): Promise<ProviderUsageLimits> => {
  const effectiveForce =
    force && now - (lastForcedAt.get(providerId) ?? 0) >= FORCE_FLOOR;
  const cached = cache.get(providerId);
  if (!effectiveForce && cached && now - cached.at < TTL)
    return Promise.resolve({ ...cached.value, source: "cache" });
  const pending = inFlight.get(providerId);
  if (pending) return pending;
  if (effectiveForce) lastForcedAt.set(providerId, now);
  const promise = fetchers[providerId]()
    .then((value) => {
      cache.set(providerId, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(providerId));
  inFlight.set(providerId, promise);
  return promise;
};

export const loadUsageLimitsCached = (
  force = false,
  providerId?: ProviderId,
  now = Date.now(),
): Promise<ProviderUsageLimits[]> => {
  if (providerId && providerId in fetchers)
    return loadProvider(providerId as keyof typeof fetchers, force, now).then(
      (value) => [value],
    );
  return Promise.all(
    (Object.keys(fetchers) as Array<keyof typeof fetchers>).map((id) =>
      loadProvider(id, force, now),
    ),
  );
};
