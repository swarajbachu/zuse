import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageLimits } from "@zuse/contracts";

import { unavailable } from "./shared.ts";

type AuthEntry = { key?: string; expires_at?: number; auth_mode?: string };

export const readGrokAuthEntry = async (): Promise<AuthEntry | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(
        join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "auth.json"),
        "utf8",
      ),
    ) as Record<string, AuthEntry>;
    const preferred = Object.entries(parsed).find(([key]) =>
      key.startsWith("https://auth.x.ai::"),
    )?.[1];
    return (
      preferred ??
      parsed["https://accounts.x.ai/sign-in"] ??
      Object.values(parsed)[0] ??
      null
    );
  } catch {
    return null;
  }
};

const readVarint = (bytes: Uint8Array, start: number): [number, number] => {
  let value = 0;
  let shift = 0;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [value, index];
};

export const parseGrokCreditsFrame = (
  bytes: Uint8Array,
  now = Date.now(),
): { usedPercent: number | null; resetsAt: string | null } => {
  let percent: number | null = null;
  let reset: number | null = null;
  const visit = (message: Uint8Array, depth: number): void => {
    if (depth > 8) return;
    for (let index = 0; index < message.length; ) {
      const [tag, next] = readVarint(message, index);
      index = next;
      const wire = tag & 7;
      if (wire === 5 && index + 4 <= message.length) {
        const value = new DataView(
          message.buffer,
          message.byteOffset + index,
          4,
        ).getFloat32(0, true);
        if (
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 100 &&
          percent === null
        )
          percent = value;
        index += 4;
      } else if (wire === 0) {
        const [value, end] = readVarint(message, index);
        index = end;
        if (
          value >= 1_700_000_000 &&
          value <= 2_100_000_000 &&
          value * 1_000 > now
        )
          reset = value;
      } else if (wire === 2) {
        const [length, end] = readVarint(message, index);
        const finish = Math.min(message.length, end + length);
        visit(message.subarray(end, finish), depth + 1);
        index = finish;
      } else if (wire === 1) index += 8;
      else break;
    }
  };
  visit(bytes, 0);
  return {
    usedPercent: percent ?? (reset ? 0 : null),
    resetsAt: reset ? new Date(reset * 1_000).toISOString() : null,
  };
};

export const parseGrokCreditsResponse = (
  bytes: Uint8Array,
  now = Date.now(),
): { usedPercent: number | null; resetsAt: string | null } => {
  const payloads: Uint8Array[] = [];
  for (let index = 0; index + 5 <= bytes.length; ) {
    const flags = bytes[index] ?? 0;
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + index + 1,
      4,
    ).getUint32(0);
    const start = index + 5;
    const end = Math.min(bytes.length, start + length);
    if ((flags & 0x80) === 0) payloads.push(bytes.subarray(start, end));
    index = end;
  }
  return parseGrokCreditsFrame(
    payloads.length > 0
      ? Uint8Array.from(payloads.flatMap((part) => [...part]))
      : bytes,
    now,
  );
};

export const fetchGrokUsage = async (): Promise<ProviderUsageLimits> => {
  const auth = await readGrokAuthEntry();
  if (!auth?.key) return unavailable("grok", "no-credentials");
  if (
    auth.expires_at &&
    auth.expires_at * (auth.expires_at < 10_000_000_000 ? 1_000 : 1) <
      Date.now()
  )
    return unavailable("grok", "expired");
  try {
    const response = await fetch(
      "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.key}`,
          "Content-Type": "application/grpc-web+proto",
          "x-grpc-web": "1",
          "x-user-agent": "connect-es/2.1.1",
          Origin: "https://grok.com",
          Referer: "https://grok.com/?_s=usage",
        },
        body: new Uint8Array(5),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok)
      return unavailable(
        "grok",
        response.status === 401 || response.status === 403
          ? "expired"
          : "error",
      );
    const body = new Uint8Array(await response.arrayBuffer());
    const parsed = parseGrokCreditsResponse(body);
    const days = parsed.resetsAt
      ? (Date.parse(parsed.resetsAt) - Date.now()) / 86_400_000
      : 0;
    return {
      providerId: "grok",
      planLabel: auth.auth_mode === "oidc" ? "SuperGrok" : null,
      creditsRemaining: null,
      fetchedAt: new Date().toISOString(),
      source: "api",
      windows: [
        {
          id: "credits",
          label: days >= 20 ? "Monthly" : days >= 4 ? "Weekly" : "Credits",
          scope: "overall",
          usedPercent: parsed.usedPercent,
          resetsAt: parsed.resetsAt,
          windowMinutes: days > 0 ? Math.round(days * 1_440) : null,
        },
      ],
    };
  } catch {
    return unavailable("grok", "error");
  }
};
