import type { ModelPricing, PricingTable } from "./litellm.ts";

/**
 * Provider prefixes tried when an exact model match fails. Mirrors ccusage's
 * DEFAULT_PROVIDER_PREFIXES so Anthropic/OpenAI/Azure model ids resolve.
 */
export const DEFAULT_PROVIDER_PREFIXES: ReadonlyArray<string> = [
  "anthropic/",
  "claude-3-5-",
  "claude-3-",
  "claude-",
  "openai/",
  "azure/",
  "openrouter/openai/",
  // xAI (Grok), Gemini, and other providers only appear in LiteLLM under a
  // provider prefix, so try them before falling back to fuzzy matching.
  "xai/",
  "gemini/",
  "vertex_ai/",
  "mistral/",
  "deepseek/",
  "openrouter/",
];

/**
 * Aliases for model ids that are agent names rather than priced models. Grok's
 * `grok-build` agent has no public price, so we estimate it with xAI's coding
 * model. Mirrors ccusage's Codex alias approach.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "grok-build": "grok-code-fast-1",
};

export interface ModelMatcher {
  (model: string | null | undefined): ModelPricing | null;
}

/**
 * Build a memoized model→pricing resolver: exact match → provider-prefixed
 * candidates → fuzzy `includes` with the smallest length difference. Ported
 * from ccusage's `getModelPricing`.
 */
export const createModelMatcher = (
  table: PricingTable,
  prefixes: ReadonlyArray<string> = DEFAULT_PROVIDER_PREFIXES,
): ModelMatcher => {
  const cache = new Map<string, ModelPricing | null>();

  return (model) => {
    if (model === null || model === undefined) return null;
    const raw = model.trim();
    if (raw === "" || raw === "unknown") return null;
    const name = MODEL_ALIASES[raw] ?? raw;
    if (cache.has(name)) return cache.get(name) ?? null;

    const direct = table.get(name);
    if (direct !== undefined) {
      cache.set(name, direct);
      return direct;
    }

    for (const prefix of prefixes) {
      const prefixed = table.get(`${prefix}${name}`);
      if (prefixed !== undefined) {
        cache.set(name, prefixed);
        return prefixed;
      }
    }

    const lower = name.toLowerCase();
    let best: { value: ModelPricing; lengthDiff: number } | null = null;
    for (const [key, value] of table) {
      const comparison = key.toLowerCase();
      if (!comparison.includes(lower) && !lower.includes(comparison)) continue;
      const lengthDiff = Math.abs(comparison.length - lower.length);
      if (best === null || lengthDiff < best.lengthDiff) best = { value, lengthDiff };
    }

    const resolved = best?.value ?? null;
    cache.set(name, resolved);
    return resolved;
  };
};
