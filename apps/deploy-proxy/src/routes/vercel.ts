import { Hono } from "hono";

import type { Env, Vars } from "../env.ts";
import {
  LIMITS,
  ownerKey,
  quotaExceededBody,
  tryConsumeDeploy,
  tryConsumeProject,
} from "../quota.ts";
import { projectNameFor, slugify, subdomainCandidates } from "../slug.ts";
import { vercelFetch } from "../vercel.ts";

type InlinedFile = {
  file: string;
  data: string;
  encoding: "base64" | "utf-8";
};
type ReferencedFile = { file: string; sha: string; size: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The caller must own the Vercel project it deploys into. */
const assertOwner = async (
  c: { env: Env },
  userId: string,
  vercelProjectId: string,
): Promise<boolean> => {
  const owner = await c.env.QUOTA.get(ownerKey(vercelProjectId));
  return owner === userId;
};

export const vercelRoutes = new Hono<{ Bindings: Env; Variables: Vars }>()
  /**
   * Idempotent project ensure: creates (or finds) the caller's project for
   * `name`, assigns a `<slug>.zuse.app` subdomain, records ownership.
   */
  .post("/projects", async (c) => {
    const userId = c.get("userId");
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      framework?: string;
    } | null;
    if (body === null || body.name === undefined || body.name === "") {
      return c.json({ error: "name required" }, 400);
    }
    const slug = slugify(body.name);
    const projectName = projectNameFor(userId, slug);

    // Existing project → verify ownership and return it.
    const existing = await vercelFetch(
      c.env,
      `/v9/projects/${encodeURIComponent(projectName)}`,
    );
    if (existing.ok && isRecord(existing.body)) {
      const projectId = String(existing.body.id);
      const owner = await c.env.QUOTA.get(ownerKey(projectId));
      if (owner !== null && owner !== userId) {
        return c.json({ error: "project belongs to another user" }, 403);
      }
      if (owner === null) await c.env.QUOTA.put(ownerKey(projectId), userId);
      const domain = await c.env.QUOTA.get(`projdomain:${projectId}`);
      return c.json({
        projectId,
        name: projectName,
        subdomain: domain ?? `${slug}.${c.env.ZUSE_APP_DOMAIN}`,
        url: `https://${domain ?? `${slug}.${c.env.ZUSE_APP_DOMAIN}`}`,
        created: false,
      });
    }

    if (!(await tryConsumeProject(c.env.QUOTA, userId))) {
      return c.json(
        quotaExceededBody(`project limit reached (${LIMITS.projectsPerUser})`),
        429,
      );
    }

    const created = await vercelFetch(c.env, "/v10/projects", {
      method: "POST",
      body: JSON.stringify({
        name: projectName,
        ...(body.framework !== undefined && body.framework !== "unknown"
          ? { framework: body.framework }
          : {}),
      }),
    });
    if (!created.ok || !isRecord(created.body)) {
      const message = created.ok ? "malformed response" : created.error.message;
      return c.json({ error: `project create failed: ${message}` }, 502);
    }
    const projectId = String(created.body.id);
    await c.env.QUOTA.put(ownerKey(projectId), userId);

    // Prefer the bare slug; on collision fall back to a user-suffixed one.
    let assigned: string | null = null;
    for (const candidate of subdomainCandidates(userId, slug)) {
      const domain = `${candidate}.${c.env.ZUSE_APP_DOMAIN}`;
      const added = await vercelFetch(
        c.env,
        `/v10/projects/${projectId}/domains`,
        { method: "POST", body: JSON.stringify({ name: domain }) },
      );
      if (added.ok) {
        assigned = domain;
        break;
      }
    }
    if (assigned !== null) {
      await c.env.QUOTA.put(`projdomain:${projectId}`, assigned);
    }
    return c.json({
      projectId,
      name: projectName,
      subdomain: assigned,
      url: assigned === null ? null : `https://${assigned}`,
      created: true,
    });
  })

  /** SHA1-keyed file upload passthrough (Vercel `/v2/files`). */
  .post("/files", async (c) => {
    const digest = c.req.header("x-vercel-digest");
    if (digest === undefined || digest === "") {
      return c.json({ error: "x-vercel-digest header required" }, 400);
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > LIMITS.maxBytesPerDeploy) {
      return c.json(quotaExceededBody("file exceeds per-deploy limit"), 429);
    }
    const uploaded = await vercelFetch(c.env, "/v2/files", {
      method: "POST",
      headers: {
        "x-vercel-digest": digest,
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    if (!uploaded.ok) {
      return c.json(
        { error: `file upload failed: ${uploaded.error.message}` },
        502,
      );
    }
    return c.json({ uploaded: true });
  })

  /**
   * Create a deployment: ownership check → daily quota → upsert env vars →
   * `POST /v13/deployments` (Vercel builds server-side).
   */
  .post("/deployments", async (c) => {
    const userId = c.get("userId");
    const body = (await c.req.json().catch(() => null)) as {
      projectId?: string;
      name?: string;
      files?: ReadonlyArray<InlinedFile | ReferencedFile>;
      env?: Record<string, string>;
      framework?: string;
      rootDirectory?: string;
    } | null;
    if (
      body === null ||
      body.projectId === undefined ||
      body.name === undefined ||
      body.files === undefined
    ) {
      return c.json({ error: "projectId, name, files required" }, 400);
    }
    if (!(await assertOwner(c, userId, body.projectId))) {
      return c.json({ error: "project belongs to another user" }, 403);
    }
    if (!(await tryConsumeDeploy(c.env.QUOTA, userId, new Date()))) {
      return c.json(
        quotaExceededBody(`daily deploy limit reached (${LIMITS.deploysPerDay})`),
        429,
      );
    }

    const inlinedBytes = body.files.reduce(
      (sum, f) => sum + ("data" in f ? f.data.length : 0),
      0,
    );
    if (inlinedBytes > LIMITS.maxBytesPerDeploy) {
      return c.json(quotaExceededBody("deploy exceeds size limit"), 429);
    }

    const envEntries = Object.entries(body.env ?? {});
    if (envEntries.length > 0) {
      const upserted = await vercelFetch(
        c.env,
        `/v10/projects/${body.projectId}/env?upsert=true`,
        {
          method: "POST",
          body: JSON.stringify(
            envEntries.map(([key, value]) => ({
              key,
              value,
              type: "encrypted",
              target: ["production", "preview"],
            })),
          ),
        },
      );
      if (!upserted.ok) {
        return c.json(
          { error: `env upsert failed: ${upserted.error.message}` },
          502,
        );
      }
    }

    const created = await vercelFetch(
      c.env,
      "/v13/deployments?skipAutoDetectionConfirmation=1&forceNew=1",
      {
        method: "POST",
        body: JSON.stringify({
          name: body.name,
          project: body.projectId,
          target: "production",
          files: body.files,
          projectSettings: {
            ...(body.framework !== undefined && body.framework !== "unknown"
              ? { framework: body.framework }
              : {}),
            ...(body.rootDirectory !== undefined && body.rootDirectory !== ""
              ? { rootDirectory: body.rootDirectory }
              : {}),
          },
        }),
      },
    );
    if (!created.ok || !isRecord(created.body)) {
      const message = created.ok ? "malformed response" : created.error.message;
      return c.json({ error: `deployment create failed: ${message}` }, 502);
    }
    await c.env.QUOTA.put(`deploy:${String(created.body.id)}`, userId);
    return c.json({
      deploymentId: String(created.body.id),
      url: typeof created.body.url === "string" ? created.body.url : null,
      status: String(created.body.readyState ?? "QUEUED"),
    });
  })

  /** Poll deployment status; on ERROR include a build-log tail. */
  .get("/deployments/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const owner = await c.env.QUOTA.get(`deploy:${id}`);
    if (owner !== userId) {
      return c.json({ error: "deployment belongs to another user" }, 403);
    }
    const res = await vercelFetch(c.env, `/v13/deployments/${id}`);
    if (!res.ok || !isRecord(res.body)) {
      const message = res.ok ? "malformed response" : res.error.message;
      return c.json({ error: `status fetch failed: ${message}` }, 502);
    }
    const status = String(res.body.readyState ?? "QUEUED");
    const url = typeof res.body.url === "string" ? res.body.url : null;

    let buildLogTail: string | null = null;
    if (status === "ERROR") {
      const events = await vercelFetch(
        c.env,
        `/v3/deployments/${id}/events?limit=200`,
      );
      if (events.ok && Array.isArray(events.body)) {
        const lines = events.body
          .map((event: unknown) =>
            isRecord(event) && isRecord(event.payload)
              ? String(event.payload.text ?? "")
              : "",
          )
          .filter((line) => line !== "");
        buildLogTail = lines.join("\n").slice(-4096);
      }
    }
    return c.json({ status, url, buildLogTail });
  });
