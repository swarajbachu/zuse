import type { Env } from "./env.ts";

export interface VercelErrorBody {
  status: number;
  message: string;
}

/**
 * Thin wrapper over the Vercel REST API: adds the team token + `teamId`
 * query param. Returns the parsed JSON body or a `VercelErrorBody` —
 * callers branch on `ok`.
 */
export const vercelFetch = async (
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<
  { ok: true; body: unknown } | { ok: false; error: VercelErrorBody }
> => {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `https://api.vercel.com${path}${sep}teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${env.VERCEL_TEAM_TOKEN}`,
        ...(init?.body !== undefined &&
        typeof init.body === "string" &&
        !(init?.headers !== undefined && "content-type" in init.headers)
          ? { "content-type": "application/json" }
          : {}),
        ...init?.headers,
      },
    },
  );
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as {
        error?: { message?: string; code?: string };
      };
      message = body.error?.message ?? body.error?.code ?? message;
    } catch {
      // non-JSON error body — keep statusText
    }
    return { ok: false, error: { status: res.status, message } };
  }
  // 204s and friends have no body
  const text = await res.text();
  return { ok: true, body: text === "" ? null : (JSON.parse(text) as unknown) };
};
