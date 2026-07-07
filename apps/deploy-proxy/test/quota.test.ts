import { describe, expect, test } from "bun:test";

import type { KvStore } from "../src/env.ts";
import {
  LIMITS,
  deploysUsedToday,
  tryConsumeDeploy,
  tryConsumeProject,
} from "../src/quota.ts";

const memoryKv = (): KvStore => {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
};

describe("deploy quota", () => {
  test("consumes up to the daily limit, then refuses", async () => {
    const kv = memoryKv();
    const now = new Date("2026-07-04T12:00:00Z");
    for (let i = 0; i < LIMITS.deploysPerDay; i++) {
      expect(await tryConsumeDeploy(kv, "u1", now)).toBe(true);
    }
    expect(await tryConsumeDeploy(kv, "u1", now)).toBe(false);
    expect(await deploysUsedToday(kv, "u1", now)).toBe(LIMITS.deploysPerDay);
  });

  test("resets across days and isolates users", async () => {
    const kv = memoryKv();
    const day1 = new Date("2026-07-04T23:00:00Z");
    const day2 = new Date("2026-07-05T01:00:00Z");
    for (let i = 0; i < LIMITS.deploysPerDay; i++) {
      await tryConsumeDeploy(kv, "u1", day1);
    }
    expect(await tryConsumeDeploy(kv, "u1", day2)).toBe(true);
    expect(await tryConsumeDeploy(kv, "u2", day1)).toBe(true);
  });
});

describe("project quota", () => {
  test("caps projects per user", async () => {
    const kv = memoryKv();
    for (let i = 0; i < LIMITS.projectsPerUser; i++) {
      expect(await tryConsumeProject(kv, "u1")).toBe(true);
    }
    expect(await tryConsumeProject(kv, "u1")).toBe(false);
  });
});
