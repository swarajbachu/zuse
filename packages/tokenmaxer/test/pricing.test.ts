import { describe, expect, it } from "vitest";

import { costFromPricing, createModelMatcher, loadBundledPricing, type ModelPricing } from "../src/index.ts";

describe("model matcher", () => {
  const table = new Map<string, ModelPricing>([
    ["claude-opus-4-8", { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 }],
    ["gpt-5", { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 }],
    ["gpt-5.4", { input_cost_per_token: 2.5e-6, output_cost_per_token: 1.5e-5 }],
  ]);

  it("resolves exact matches", () => {
    expect(createModelMatcher(table)("claude-opus-4-8")?.input_cost_per_token).toBe(5e-6);
  });

  it("resolves provider-prefixed matches", () => {
    const prefixed = new Map<string, ModelPricing>([
      ["anthropic/claude-x", { input_cost_per_token: 9e-6 }],
    ]);
    expect(createModelMatcher(prefixed)("claude-x")?.input_cost_per_token).toBe(9e-6);
  });

  it("prefers the closest-length fuzzy match", () => {
    expect(createModelMatcher(table)("gpt-5.4-mini")?.input_cost_per_token).toBe(2.5e-6);
  });

  it("returns null for unknown / 'unknown' models", () => {
    const match = createModelMatcher(table);
    expect(match("totally-unknown-xyz")).toBeNull();
    expect(match("unknown")).toBeNull();
    expect(match(null)).toBeNull();
  });
});

describe("cost from pricing", () => {
  it("prices each token type independently", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 25e-6,
      cache_creation_input_token_cost: 6.25e-6,
      cache_read_input_token_cost: 5e-7,
    };
    const cost = costFromPricing(
      { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 2000, cacheReadTokens: 10_000, reasoningTokens: 0 },
      pricing,
    );
    expect(cost).toBeCloseTo(1000 * 5e-6 + 500 * 25e-6 + 2000 * 6.25e-6 + 10_000 * 5e-7);
  });

  it("applies tiered pricing above 200k", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      input_cost_per_token_above_200k_tokens: 6e-6,
    };
    const cost = costFromPricing(
      { inputTokens: 300_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
      pricing,
    );
    expect(cost).toBeCloseTo(200_000 * 3e-6 + 100_000 * 6e-6);
  });

  it("applies the fast multiplier", () => {
    const pricing: ModelPricing = { input_cost_per_token: 5e-6, provider_specific_entry: { fast: 2 } };
    const counts = { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
    expect(costFromPricing(counts, pricing, true)).toBeCloseTo(costFromPricing(counts, pricing, false) * 2);
  });
});

describe("bundled pricing snapshot", () => {
  it("loads common models offline", () => {
    const table = loadBundledPricing();
    expect(table.size).toBeGreaterThan(100);
    expect(table.get("claude-opus-4-8")?.input_cost_per_token).toBe(5e-6);
  });
});
