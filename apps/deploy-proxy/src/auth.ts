import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Env, Vars } from "./env.ts";

/** Remote JWKS sets are cached per URL for the isolate's lifetime. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const jwksFor = (url: string) => {
  let set = jwksCache.get(url);
  if (set === undefined) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
};

/**
 * Every deploy is attributable to a WorkOS user: the desktop sends its
 * WorkOS access token and we verify it against the WorkOS JWKS. `sub` is
 * the user id used for quota + project-ownership keys.
 */
export const requireUser: MiddlewareHandler<{
  Bindings: Env;
  Variables: Vars;
}> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token === null || token === "") {
    return c.json({ error: "missing bearer token" }, 401);
  }

  const dev = c.env.DEV_BEARER_TOKEN;
  if (dev !== undefined && dev !== "" && token === dev) {
    c.set("userId", "dev-user");
    return next();
  }

  try {
    const { payload } = await jwtVerify(token, jwksFor(c.env.WORKOS_JWKS_URL));
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (sub === null || sub === "") {
      return c.json({ error: "token has no subject" }, 401);
    }
    c.set("userId", sub);
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }
  return next();
};
