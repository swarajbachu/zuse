import { Hono } from "hono";

import { requireUser } from "./auth.ts";
import type { Env, Vars } from "./env.ts";
import { LIMITS, deploysUsedToday, projectsUsed } from "./quota.ts";
import { convexRoutes } from "./routes/convex.ts";
import { vercelRoutes } from "./routes/vercel.ts";

/**
 * zuse deploy-proxy — the only holder of Zuse's Vercel team token and the
 * Convex OAuth client secret (ADR 0022). Every route below `/v1` requires a
 * verified WorkOS access token; quotas + project ownership are enforced in
 * the route handlers.
 */
export const app = new Hono<{ Bindings: Env; Variables: Vars }>()
  .get("/healthz", (c) => c.json({ ok: true }))
  .use("/v1/*", requireUser)
  .route("/v1/convex", convexRoutes)
  .route("/v1/vercel", vercelRoutes)
  .get("/v1/quota", async (c) => {
    const userId = c.get("userId");
    return c.json({
      deploysUsedToday: await deploysUsedToday(c.env.QUOTA, userId, new Date()),
      deployLimit: LIMITS.deploysPerDay,
      projectsUsed: await projectsUsed(c.env.QUOTA, userId),
      projectLimit: LIMITS.projectsPerUser,
    });
  });

export default app;
