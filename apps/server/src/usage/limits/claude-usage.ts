import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderUsageLimits, UsageLimitWindow } from "@zuse/contracts";

import { normalizePercent, normalizeReset, unavailable } from "./shared.ts";

type ClaudeWindow = { utilization?: number; resets_at?: string | number };
type ClaudePayload = Record<string, unknown> & {
  extra_usage?: { balance?: number; credits_remaining?: number };
  subscriptionType?: string;
  rate_limit_tier?: string;
};

const title = (value: string) =>
  value
    .split(/[-_]/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

export const parseClaudeUsagePayload = (
  payload: ClaudePayload,
  fetchedAt = new Date().toISOString(),
): ProviderUsageLimits => {
  const windows: UsageLimitWindow[] = [];
  for (const [key, raw] of Object.entries(payload)) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as ClaudeWindow;
    if (key === "five_hour")
      windows.push({
        id: key,
        label: "Session",
        scope: "session",
        usedPercent: normalizePercent(item.utilization),
        resetsAt: normalizeReset(item.resets_at),
        windowMinutes: 300,
      });
    else if (key === "seven_day")
      windows.push({
        id: key,
        label: "Weekly",
        scope: "weekly",
        usedPercent: normalizePercent(item.utilization),
        resetsAt: normalizeReset(item.resets_at),
        windowMinutes: 10_080,
      });
    else if (key.startsWith("seven_day_"))
      windows.push({
        id: key,
        label: `Weekly (${title(key.slice(10))})`,
        scope: "model",
        usedPercent: normalizePercent(item.utilization),
        resetsAt: normalizeReset(item.resets_at),
        windowMinutes: 10_080,
      });
  }
  return {
    providerId: "claude",
    planLabel: payload.subscriptionType ?? payload.rate_limit_tier ?? null,
    windows,
    creditsRemaining:
      payload.extra_usage?.credits_remaining ??
      payload.extra_usage?.balance ??
      null,
    fetchedAt,
    source: "api",
  };
};

export type ClaudeCredentialResult =
  | { token: string; reason?: never }
  | { token?: never; reason: "no-credentials" | "expired" | "scope-missing" };

type ClaudeCredentialBlob = {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    scopes?: string[];
  };
};

const credentialFromBlob = (raw: string): ClaudeCredentialResult => {
  const oauth = (JSON.parse(raw) as ClaudeCredentialBlob).claudeAiOauth;
  if (!oauth?.accessToken) return { reason: "no-credentials" };
  if (oauth.expiresAt && oauth.expiresAt < Date.now())
    return { reason: "expired" };
  if (oauth.scopes && !oauth.scopes.includes("user:profile"))
    return { reason: "scope-missing" };
  return { token: oauth.accessToken };
};

export const readClaudeAccessToken =
  async (): Promise<ClaudeCredentialResult> => {
    try {
      return credentialFromBlob(
        await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"),
      );
    } catch {
      if (process.platform !== "darwin") return { reason: "no-credentials" };
      try {
        const { stdout } = await promisify(execFile)(
          "/usr/bin/security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { timeout: 3_000, maxBuffer: 1_000_000 },
        );
        return credentialFromBlob(stdout.trim());
      } catch {
        return { reason: "no-credentials" };
      }
    }
  };

export const fetchClaudeUsage = async (): Promise<ProviderUsageLimits> => {
  const credential = await readClaudeAccessToken();
  if (!("token" in credential)) return unavailable("claude", credential.reason);
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      return unavailable(
        "claude",
        response.status === 401
          ? "expired"
          : response.status === 403
            ? "scope-missing"
            : "error",
      );
    return parseClaudeUsagePayload((await response.json()) as ClaudePayload);
  } catch {
    return unavailable("claude", "error");
  }
};
