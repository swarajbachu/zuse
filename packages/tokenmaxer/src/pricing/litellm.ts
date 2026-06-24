import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Subset of the LiteLLM `model_prices_and_context_window.json` schema that we
 * use for cost calculation. Costs are per-token (e.g. 0.000005), matching the
 * upstream format. Mirrors ccusage's `liteLLMModelPricingSchema`.
 */
export interface ModelPricing {
  readonly input_cost_per_token?: number;
  readonly output_cost_per_token?: number;
  readonly cache_creation_input_token_cost?: number;
  readonly cache_read_input_token_cost?: number;
  readonly max_input_tokens?: number;
  readonly input_cost_per_token_above_200k_tokens?: number;
  readonly output_cost_per_token_above_200k_tokens?: number;
  readonly cache_creation_input_token_cost_above_200k_tokens?: number;
  readonly cache_read_input_token_cost_above_200k_tokens?: number;
  readonly provider_specific_entry?: { readonly fast?: number };
}

export type PricingTable = ReadonlyMap<string, ModelPricing>;

export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const CACHE_FILE_NAME = "litellm-prices.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NUMERIC_FIELDS: ReadonlyArray<keyof ModelPricing> = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "max_input_tokens",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost_above_200k_tokens",
];

const bundledSnapshotPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", CACHE_FILE_NAME);

const parsePricingRecord = (data: unknown): Map<string, ModelPricing> => {
  const table = new Map<string, ModelPricing>();
  if (data === null || typeof data !== "object") return table;
  for (const [model, raw] of Object.entries(data as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") continue;
    const source = raw as Record<string, unknown>;
    const entry: Record<string, unknown> = {};
    for (const field of NUMERIC_FIELDS) {
      const value = source[field];
      if (typeof value === "number" && Number.isFinite(value)) entry[field] = value;
    }
    const pse = source.provider_specific_entry;
    if (pse !== null && typeof pse === "object" && typeof (pse as { fast?: unknown }).fast === "number") {
      entry.provider_specific_entry = { fast: (pse as { fast: number }).fast };
    }
    if (Object.keys(entry).length > 0) table.set(model, entry as ModelPricing);
  }
  return table;
};

const readJsonFile = (path: string): unknown | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Bundled offline snapshot — always available, used as the final fallback. */
export const loadBundledPricing = (): PricingTable => {
  const data = readJsonFile(bundledSnapshotPath());
  return data === null ? new Map() : parsePricingRecord(data);
};

export interface LoadPricingOptions {
  /** Skip the network; use disk cache or the bundled snapshot only. */
  readonly offline?: boolean;
  /** Directory to read/write the cached pricing JSON (defaults to a temp dir). */
  readonly cacheDir?: string;
  /** Override "now" for cache-freshness checks (tests). */
  readonly now?: number;
}

let inFlight: Promise<PricingTable> | null = null;
let memo: PricingTable | null = null;

const resolveCacheDir = (cacheDir?: string): string =>
  cacheDir ?? join(process.env.TMPDIR ?? "/tmp", "tokenmaxer");

const readFreshCache = (cachePath: string, now: number): PricingTable | null => {
  try {
    if (!existsSync(cachePath)) return null;
    if (now - statSync(cachePath).mtimeMs > CACHE_TTL_MS) return null;
  } catch {
    return null;
  }
  const data = readJsonFile(cachePath);
  if (data === null) return null;
  const table = parsePricingRecord(data);
  return table.size > 0 ? table : null;
};

const writeCache = (cachePath: string, data: unknown): void => {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data));
  } catch {
    // Cache writes are best-effort; failure just means we refetch next time.
  }
};

/**
 * Resolve the LiteLLM pricing table, preferring (1) a fresh on-disk cache,
 * (2) a live fetch (cached to disk), then falling back to (3) a stale cache or
 * (4) the bundled snapshot. The live fetch is shared across concurrent callers.
 */
export const loadPricingTable = async (options: LoadPricingOptions = {}): Promise<PricingTable> => {
  const now = options.now ?? Date.now();
  const cachePath = join(resolveCacheDir(options.cacheDir), CACHE_FILE_NAME);

  const fresh = readFreshCache(cachePath, now);
  if (fresh !== null) return fresh;

  if (options.offline === true) {
    const data = readJsonFile(cachePath);
    const cached = data === null ? new Map() : parsePricingRecord(data);
    return cached.size > 0 ? cached : loadBundledPricing();
  }

  if (memo !== null) return memo;
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(LITELLM_PRICING_URL, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`pricing fetch failed: ${response.status}`);
      const data = (await response.json()) as unknown;
      const table = parsePricingRecord(data);
      if (table.size === 0) throw new Error("pricing fetch returned no models");
      writeCache(cachePath, data);
      memo = table;
      return table;
    } catch {
      const staleData = readJsonFile(cachePath);
      const stale = staleData === null ? new Map() : parsePricingRecord(staleData);
      return stale.size > 0 ? stale : loadBundledPricing();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};

/** Reset memoized pricing (tests). */
export const resetPricingCache = (): void => {
  inFlight = null;
  memo = null;
};
