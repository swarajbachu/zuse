import type { KvStore } from "./env.ts";

/** Per-user limits (ADR 0022). Tunable here without a desktop release. */
export const LIMITS = {
  projectsPerUser: 10,
  deploysPerDay: 30,
  maxBytesPerDeploy: 100 * 1024 * 1024,
} as const;

const dayKey = (userId: string, now: Date): string =>
  `quota:${userId}:deploys:${now.toISOString().slice(0, 10)}`;

const projectsKey = (userId: string): string => `quota:${userId}:projects`;

const readCount = async (kv: KvStore, key: string): Promise<number> => {
  const raw = await kv.get(key);
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const deploysUsedToday = (kv: KvStore, userId: string, now: Date) =>
  readCount(kv, dayKey(userId, now));

export const projectsUsed = (kv: KvStore, userId: string) =>
  readCount(kv, projectsKey(userId));

/** Returns false when the user is out of daily deploys (counter untouched). */
export const tryConsumeDeploy = async (
  kv: KvStore,
  userId: string,
  now: Date,
): Promise<boolean> => {
  const key = dayKey(userId, now);
  const used = await readCount(kv, key);
  if (used >= LIMITS.deploysPerDay) return false;
  await kv.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
};

/** Returns false when the user is at their project cap (counter untouched). */
export const tryConsumeProject = async (
  kv: KvStore,
  userId: string,
): Promise<boolean> => {
  const key = projectsKey(userId);
  const used = await readCount(kv, key);
  if (used >= LIMITS.projectsPerUser) return false;
  await kv.put(key, String(used + 1));
  return true;
};

/** Project → owning WorkOS user. Load-bearing against cross-user deploys. */
export const ownerKey = (vercelProjectId: string): string =>
  `proj:${vercelProjectId}`;

export const quotaExceededBody = (reason: string) => ({
  error: reason,
  quotaExceeded: true,
});
