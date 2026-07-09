import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { SessionStoreError } from "../errors.ts";
import { SessionStore } from "../services/session-store.ts";
import { parseSessionBundle, type SessionBundle } from "./workos.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 40;

const authDir = (): string =>
  process.env.ZUSE_AUTH_DIR?.trim() || join(homedir(), ".zuse");
const authFile = (): string => join(authDir(), "auth.json");
const lockFile = (): string => join(authDir(), "auth.lock");

const failStore = (reason: string, cause?: unknown): SessionStoreError =>
  new SessionStoreError({ reason, cause });

const io = <A>(
  description: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, SessionStoreError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => failStore(description, cause),
  });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: unknown }).code === "ENOENT";

const isExists = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: unknown }).code === "EEXIST";

const ensureAuthDir = (): Effect.Effect<void, SessionStoreError> =>
  io("Failed to create auth directory.", async () => {
    await mkdir(authDir(), { recursive: true, mode: 0o700 });
    await chmod(authDir(), 0o700);
  });

const readBundleFile = (): Effect.Effect<
  SessionBundle | null,
  SessionStoreError
> =>
  Effect.tryPromise({
    try: async () => await readFile(authFile(), "utf8"),
    catch: (cause) => failStore("Failed to read auth session.", cause),
  }).pipe(
    Effect.catchAll((cause) =>
      isNotFound(cause.cause) ? Effect.succeed(null) : Effect.fail(cause),
    ),
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed(null);
      return Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => failStore("Auth session file is corrupt.", cause),
      }).pipe(Effect.map(parseSessionBundle));
    }),
  );

const writeBundleFile = (
  bundle: SessionBundle,
): Effect.Effect<void, SessionStoreError> =>
  Effect.gen(function* () {
    yield* ensureAuthDir();
    const target = authFile();
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    const contents = JSON.stringify(bundle);
    yield* io("Failed to write auth session.", async () => {
      await writeFile(tmp, contents, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, target);
      await chmod(target, 0o600);
    }).pipe(
      Effect.ensuring(
        io("Failed to clean temporary auth session.", () =>
          rm(tmp, { force: true }),
        ).pipe(Effect.ignore),
      ),
    );
  });

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      (cause as { code?: unknown }).code !== "ESRCH"
    );
  }
};

const lockIsStale = (raw: string): boolean => {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    const createdAt =
      typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
    const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
    return Date.now() - createdAt > LOCK_STALE_MS || !pidIsAlive(pid);
  } catch {
    return true;
  }
};

const readLockRaw = (): Effect.Effect<string | null, never> =>
  Effect.tryPromise({
    try: async () => await readFile(lockFile(), "utf8"),
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

const acquireLock = (attempt = 0): Effect.Effect<string, SessionStoreError> =>
  ensureAuthDir().pipe(
    Effect.zipRight(
      Effect.tryPromise({
        try: async () => {
          const token = randomUUID();
          const handle = await open(
            lockFile(),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          );
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }),
          );
          await handle.close();
          return token;
        },
        catch: (cause) => cause,
      }),
    ),
    Effect.catchAll((cause) => {
      if (!isExists(cause)) {
        return Effect.fail(
          failStore("Failed to acquire auth session lock.", cause),
        );
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        return Effect.fail(
          failStore("Timed out waiting for auth session lock.", cause),
        );
      }
      return Effect.gen(function* () {
        const raw = yield* readLockRaw();
        if (raw === null || lockIsStale(raw)) {
          yield* io("Failed to remove stale auth session lock.", async () => {
            const current = await readFile(lockFile(), "utf8").catch(
              () => null,
            );
            if (current === raw) await unlink(lockFile());
          }).pipe(Effect.catchAll(() => Effect.void));
        } else {
          yield* Effect.sleep("150 millis");
        }
        return yield* acquireLock(attempt + 1);
      });
    }),
  );

const releaseLock = (token: string): Effect.Effect<void, never> =>
  io("Failed to release auth session lock.", async () => {
    const raw = await readFile(lockFile(), "utf8").catch(() => null);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (parsed.token === token) await unlink(lockFile());
    } catch {
      await unlink(lockFile());
    }
  }).pipe(Effect.ignore);

export const SessionStoreLive = Layer.succeed(
  SessionStore,
  SessionStore.of({
    read: () => readBundleFile(),
    write: (incoming) =>
      Effect.gen(function* () {
        yield* ensureAuthDir();
        const current = yield* readBundleFile();
        if (current !== null && current.refreshedAt > incoming.refreshedAt) {
          return current;
        }
        yield* writeBundleFile(incoming);
        return incoming;
      }),
    clear: () =>
      io("Failed to clear auth session.", () =>
        rm(authFile(), { force: true }),
      ),
    withLock: (effect) =>
      Effect.acquireUseRelease(acquireLock(), () => effect, releaseLock),
  }),
);
