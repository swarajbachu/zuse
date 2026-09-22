import { randomUUID } from "node:crypto";
import { chmodSync, constants } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WORKOS_PUBLIC_CLIENT_ID } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { SessionStoreError } from "../errors.ts";
import { SessionStore } from "../services/session-store.ts";
import { parseSessionBundle, type SessionBundle } from "./workos.ts";

const LOCK_MAX_ATTEMPTS = 140;

const authDir = (): string =>
	process.env.ZUSE_AUTH_DIR?.trim() || join(homedir(), ".zuse");
/**
 * The session store is partitioned by WorkOS client so builds signed into
 * different identity environments (staging dev builds vs the packaged
 * production app) never share — or clear — each other's session. One shared
 * file caused mutual sign-outs: a staging build refreshing a production
 * refresh token gets `invalid_grant` and wipes the production session (and
 * vice versa), killing both within one access-token lifetime.
 */
const sessionClientId = (): string =>
	(process.env.WORKOS_CLIENT_ID ?? "").trim() || WORKOS_PUBLIC_CLIENT_ID;
const authFile = (): string =>
	join(authDir(), `auth-${sessionClientId()}.json`);
const legacyAuthFile = (): string => join(authDir(), "auth.json");
const lockFile = (): string =>
	join(authDir(), `auth-${sessionClientId()}.lock`);

/** Whether a bundle's access token was minted by this build's WorkOS client. */
export const sessionBundleMatchesClient = (
	accessToken: string,
	clientId: string,
): boolean => {
	try {
		const payload = accessToken.split(".")[1] ?? "";
		const normalized = payload.replace(/-/gu, "+").replace(/_/gu, "/");
		const decoded = JSON.parse(
			Buffer.from(normalized, "base64").toString("utf8"),
		) as { readonly client_id?: unknown; readonly iss?: unknown };
		return (
			decoded.client_id === clientId ||
			(typeof decoded.iss === "string" && decoded.iss.endsWith(`/${clientId}`))
		);
	} catch {
		return false;
	}
};

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

const readBundleAt = (
	path: string,
): Effect.Effect<SessionBundle | null, SessionStoreError> =>
	Effect.tryPromise({
		try: async () => await readFile(path, "utf8"),
		catch: (cause) => failStore("Failed to read auth session.", cause),
	}).pipe(
		Effect.catch((cause) =>
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

const readBundleFile = (): Effect.Effect<
	SessionBundle | null,
	SessionStoreError
> =>
	Effect.gen(function* () {
		const current = yield* readBundleAt(authFile());
		if (current !== null) return current;
		// One-time adoption from the legacy shared file: only a bundle minted by
		// this build's WorkOS client moves over. A bundle from another identity
		// environment is left in place for the build that owns it.
		const legacy = yield* readBundleAt(legacyAuthFile()).pipe(
			Effect.catch(() => Effect.succeed(null)),
		);
		if (
			legacy === null ||
			!sessionBundleMatchesClient(legacy.accessToken, sessionClientId())
		) {
			return null;
		}
		yield* writeBundleFile(legacy);
		yield* io("Failed to retire legacy auth session.", () =>
			rm(legacyAuthFile(), { force: true }),
		).pipe(Effect.ignore);
		return legacy;
	});

const writeBundleFile = (
	bundle: SessionBundle,
): Effect.Effect<void, SessionStoreError> =>
	Effect.gen(function* () {
		yield* ensureAuthDir();
		const target = authFile();
		const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
		const contents = JSON.stringify(bundle);
		yield* io("Failed to write auth session.", async () => {
			const handle = await open(
				tmp,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
				0o600,
			);
			try {
				await handle.writeFile(contents);
				await handle.chmod(0o600);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(tmp, target);
			await chmod(target, 0o600);
			// Persist the rename itself so a power loss cannot resurrect the
			// consumed refresh token after WorkOS has rotated it.
			const directory = await open(authDir(), constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
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

export const sessionLockIsStale = (raw: string): boolean => {
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
		const createdAt =
			typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
		const pid =
			typeof parsed.pid === "number" &&
			Number.isSafeInteger(parsed.pid) &&
			parsed.pid > 0
				? parsed.pid
				: null;
		if (pid === null || !Number.isFinite(createdAt) || createdAt <= 0) {
			// Older clients expose partially written metadata. Missing ownership
			// is not evidence of abandonment; wait or fail without stealing it.
			return false;
		}
		// A slow or suspended owner still owns its lock. Reused PIDs may delay
		// recovery, but cannot justify concurrent refresh-token use.
		return !pidIsAlive(pid);
	} catch {
		return false;
	}
};

/**
 * Serialize lock-file creation, stale recovery, and the protected operation
 * across runtimes and processes. A read/check/unlink sequence is not a filesystem
 * compare-and-swap, and O_EXCL exposes the file before its metadata is written.
 * SQLite supplies an OS-backed lock released on close or process death, without
 * stale-file cleanup. Never unlink this database: that would split ownership
 * between different inodes. It stores no session data.
 *
 * Keep the JSON lock inside this guard so older installations still see ownership.
 */
const acquireProcessLock = (): Effect.Effect<DatabaseSync, SessionStoreError> =>
	Effect.gen(function* () {
		yield* ensureAuthDir();
		const path = `${lockFile()}.sqlite`;
		for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
			const result = yield* Effect.try({
				try: () => {
					const database = new DatabaseSync(path);
					try {
						// Let SQLite manage every descriptor for this file. Closing an
						// unrelated descriptor can release POSIX locks held by this process.
						chmodSync(path, 0o600);
						// Waiting synchronously would block the owner in this same event loop.
						database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
						return database;
					} catch (cause) {
						database.close();
						throw cause;
					}
				},
				catch: (cause) => cause,
			}).pipe(Effect.result);
			if (result._tag === "Success") return result.success;
			const cause = result.failure;
			if (
				!(
					typeof cause === "object" &&
					cause !== null &&
					"errcode" in cause &&
					typeof cause.errcode === "number" &&
					(cause.errcode & 255) === 5
				)
			) {
				return yield* Effect.fail(
					failStore("Failed to acquire auth process lock.", cause),
				);
			}
			yield* Effect.sleep("150 millis");
		}
		return yield* Effect.fail(
			failStore("Timed out waiting for auth process lock."),
		);
	});

const readLockRaw = (): Effect.Effect<string | null, never> =>
	Effect.tryPromise({
		try: async () => await readFile(lockFile(), "utf8"),
		catch: (cause) => cause,
	}).pipe(Effect.catch(() => Effect.succeed(null)));

const acquireLock = (attempt = 0): Effect.Effect<string, SessionStoreError> =>
	ensureAuthDir().pipe(
		Effect.andThen(
			Effect.tryPromise({
				try: async () => {
					const token = randomUUID();
					const path = lockFile();
					const temporary = `${path}.tmp.${token}`;
					const handle = await open(temporary, "wx", 0o600);
					try {
						try {
							await handle.writeFile(
								JSON.stringify({
									pid: process.pid,
									createdAt: Date.now(),
									token,
								}),
							);
						} finally {
							await handle.close();
						}
						// Publish complete ownership metadata without replacing another owner.
						// This also prevents older clients from mistaking a new lock for corrupt JSON.
						await link(temporary, path);
					} finally {
						// Once linked, ownership must reach the caller even if temp cleanup fails.
						await rm(temporary, { force: true }).catch(() => undefined);
					}
					return token;
				},
				catch: (cause) => cause,
			}),
		),
		Effect.catch((cause) => {
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
				if (raw !== null && sessionLockIsStale(raw)) {
					yield* io("Failed to remove stale auth session lock.", async () => {
						const current = await readFile(lockFile(), "utf8").catch(
							() => null,
						);
						if (current === raw) await unlink(lockFile());
					}).pipe(Effect.catch(() => Effect.void));
				} else {
					yield* Effect.sleep("150 millis");
				}
				return yield* acquireLock(attempt + 1);
			});
		}),
	);

const releaseLock = (token: string): Effect.Effect<void, never> =>
	io("Failed to release auth session lock.", async () => {
		const raw = await readFile(lockFile(), "utf8").catch((cause: unknown) => {
			if (isNotFound(cause)) return null;
			throw cause;
		});
		if (raw === null) return;
		const parsed = JSON.parse(raw) as { token?: unknown };
		if (parsed.token === token) await unlink(lockFile());
	}).pipe(
		// The outer SQLite transaction remains held throughout finalization.
		Effect.retry({ times: 2 }),
		Effect.orDie,
	);

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
			Effect.acquireUseRelease(
				acquireProcessLock(),
				() =>
					Effect.acquireUseRelease(acquireLock(), () => effect, releaseLock),
				(database) => Effect.sync(() => database.close()),
			),
	}),
);
