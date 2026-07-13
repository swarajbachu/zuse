import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";

export const unavailable = (
  providerId: ProviderId,
  unavailableReason: NonNullable<ProviderUsageLimits["unavailableReason"]>,
): ProviderUsageLimits => ({
  providerId,
  planLabel: null,
  windows: [],
  creditsRemaining: null,
  fetchedAt: new Date().toISOString(),
  source: "api",
  unavailableReason,
});

export const normalizePercent = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, percent));
};

export const normalizeReset = (value: unknown): string | null => {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const ms = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(ms).toISOString();
};
