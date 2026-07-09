import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, ManagedRuntime } from "effect";

import { SessionStoreLive } from "../src/auth/layers/session-store.ts";
import type { SessionBundle } from "../src/auth/layers/workos.ts";
import { SessionStore } from "../src/auth/services/session-store.ts";

const originalAuthDir = process.env.ZUSE_AUTH_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalAuthDir === undefined) {
    delete process.env.ZUSE_AUTH_DIR;
  } else {
    process.env.ZUSE_AUTH_DIR = originalAuthDir;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const makeTempAuthDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "zuse-auth-"));
  tempDirs.push(dir);
  process.env.ZUSE_AUTH_DIR = dir;
  return dir;
};

const makeBundle = (overrides: Partial<SessionBundle> = {}): SessionBundle => ({
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 60_000,
  refreshedAt: Date.now(),
  organizationId: null,
  user: {
    id: "user_123",
    email: "user@example.com",
    firstName: null,
    lastName: null,
    profilePictureUrl: null,
  },
  ...overrides,
});

const withStore = async <A>(
  fn: (svc: typeof SessionStore.Service) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(SessionStoreLive);
  try {
    return await runtime.runPromise(Effect.flatMap(SessionStore, fn));
  } finally {
    await runtime.dispose();
  }
};

describe("SessionStoreLive", () => {
  it("returns null when the session file is absent", async () => {
    await makeTempAuthDir();
    const value = await withStore((svc) => svc.read());
    expect(value).toBe(null);
  });

  it("writes atomically with 0600 permissions and reads the bundle", async () => {
    const dir = await makeTempAuthDir();
    const bundle = makeBundle({ refreshToken: "newer", refreshedAt: 2 });
    await withStore((svc) => svc.write(bundle));
    const path = join(dir, "auth.json");
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      refreshToken: "newer",
      refreshedAt: 2,
    });
    const read = await withStore((svc) => svc.read());
    expect(read?.refreshToken).toBe("newer");
  });

  it("fails on corrupt JSON but treats wrong-shape JSON as signed out", async () => {
    const dir = await makeTempAuthDir();
    await writeFile(join(dir, "auth.json"), "{", { mode: 0o600 });
    const corrupt = await withStore((svc) => svc.read().pipe(Effect.either));
    expect(corrupt._tag).toBe("Left");

    await writeFile(join(dir, "auth.json"), JSON.stringify({ nope: true }), {
      mode: 0o600,
    });
    const wrongShape = await withStore((svc) => svc.read());
    expect(wrongShape).toBe(null);
  });

  it("refuses to overwrite a newer bundle", async () => {
    await makeTempAuthDir();
    const newer = makeBundle({ refreshToken: "newer", refreshedAt: 10 });
    const older = makeBundle({ refreshToken: "older", refreshedAt: 1 });
    await withStore((svc) => svc.write(newer));
    const winner = await withStore((svc) => svc.write(older));
    expect(winner.refreshToken).toBe("newer");
    const stored = await withStore((svc) => svc.read());
    expect(stored?.refreshToken).toBe("newer");
  });

  it("serializes work under the lock and breaks stale locks", async () => {
    const dir = await makeTempAuthDir();
    await writeFile(
      join(dir, "auth.lock"),
      JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }),
      { mode: 0o600 },
    );
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        withStore((svc) =>
          svc.withLock(
            Effect.gen(function* () {
              active += 1;
              maxActive = Math.max(maxActive, active);
              yield* Effect.sleep("20 millis");
              active -= 1;
            }),
          ),
        ),
      ),
    );
    expect(maxActive).toBe(1);
  });
});
