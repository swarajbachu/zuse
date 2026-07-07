import { Hono } from "hono";

import type { Env, Vars } from "../env.ts";

/**
 * Convex platform-OAuth token exchange. The desktop runs the PKCE flow
 * against `dashboard.convex.dev/oauth/authorize/team`, but Convex's token
 * endpoint requires the OAuth app's `client_secret` even with PKCE — so the
 * exchange (and only the exchange) routes through here. Management API
 * calls go desktop → api.convex.dev directly with the user's token.
 */
export const convexRoutes = new Hono<{ Bindings: Env; Variables: Vars }>().post(
  "/oauth/token",
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      grantType?: string;
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
      refreshToken?: string;
    } | null;
    if (body === null) return c.json({ error: "invalid JSON body" }, 400);

    const params = new URLSearchParams({
      client_id: c.env.CONVEX_OAUTH_CLIENT_ID,
      client_secret: c.env.CONVEX_OAUTH_CLIENT_SECRET,
    });
    if (body.grantType === "refresh_token") {
      if (body.refreshToken === undefined) {
        return c.json({ error: "refreshToken required" }, 400);
      }
      params.set("grant_type", "refresh_token");
      params.set("refresh_token", body.refreshToken);
    } else {
      if (body.code === undefined || body.redirectUri === undefined) {
        return c.json({ error: "code and redirectUri required" }, 400);
      }
      params.set("grant_type", "authorization_code");
      params.set("code", body.code);
      params.set("redirect_uri", body.redirectUri);
      if (body.codeVerifier !== undefined) {
        params.set("code_verifier", body.codeVerifier);
      }
    }

    const res = await fetch("https://api.convex.dev/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || payload.access_token === undefined) {
      return c.json(
        {
          error:
            payload.error_description ??
            payload.error ??
            `convex token exchange failed (${res.status})`,
        },
        res.status === 400 ? 400 : 502,
      );
    }
    return c.json({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresIn: payload.expires_in ?? null,
    });
  },
);
