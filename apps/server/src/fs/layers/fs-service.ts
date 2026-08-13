import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import * as path from "node:path";
import {
	DirectoryUnavailableError,
	type FolderId,
	FsAlreadyExistsError,
	FsCommandReuseError,
	FsConflictError,
	FsEntry,
	FsExternalConflictError,
	FsExternalReadError,
	FsExternalTooLargeError,
	FsFolderNotFoundError,
	FsPathOutsideError,
	FsReadError,
	FsTooLargeError,
	FsTreeWatchEvent,
	type WorktreeId,
} from "@zuse/contracts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, FileSystem, Layer, Option, Path, Queue, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { FsService } from "../services/fs-service.ts";

// Skip directories that are large, irrelevant, or just noise in a code-tree
// view. Match by basename. Hidden dotfiles other than `.git` still show up —
// users often want to see `.env`, `.github/`, `.vscode/`, etc.
const SKIP_DIRS = new Set([".git", "node_modules", ".zuse", ".DS_Store"]);
const WATCH_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".zuse",
	".DS_Store",
	"dist",
	"build",
	".turbo",
	".next",
	".cache",
	"coverage",
	"out",
]);
const WATCH_DEBOUNCE_MS = 120;

// Cap how much we'll ship across the RPC for a single file. Anything larger
// surfaces as `FsTooLargeError` so the editor can render a placeholder
// instead of trying to load gigabytes into a CodeMirror buffer.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Hard cap on how many paths `fs.listPaths` returns for the file tree. The
// path-first tree wants the whole universe up front; this keeps a pathological
// monorepo from streaming hundreds of thousands of entries across the RPC.
const MAX_TREE_PATHS = 50_000;
// Leave framing/schema overhead under the 1 MiB initial-sync budget.
const MAX_TREE_PATH_BYTES = 900 * 1024;
const FS_WRITE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_APPLIED_FS_WRITE_RECEIPTS = 10_000;

type FsWriteReceipt = {
	readonly folder_id: string;
	readonly worktree_id: string | null;
	readonly path: string;
	readonly expected_mtime: string;
	readonly content_hash: string;
	readonly state: "prepared" | "applied";
	readonly mtime: string | null;
};

type TreeWatchState = {
	readonly epoch: string;
	sequence: number;
};

const toForwardSlash = (p: string): string =>
	path.sep === "/" ? p : p.split(path.sep).join("/");

const isSkippedWatchPath = (relPath: string): boolean => {
	const first = toForwardSlash(relPath).split("/")[0] ?? "";
	return WATCH_SKIP_DIRS.has(first);
};

const mtimeToString = (mtime: Option.Option<Date>): string =>
	Option.match(mtime, {
		onNone: () => "",
		onSome: (d) => d.toISOString(),
	});

const sha256 = (value: string | Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");

export const FsServiceLive = Layer.effect(
	FsService,
	Effect.gen(function* () {
		const workspace = yield* WorkspaceService;
		const worktrees = yield* WorktreeService;
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;
		const writeSerial = new KeyedEffectSerialWorker<string>();

		// Resolve a project-root-relative request path to an absolute path,
		// failing with the appropriate wire error if the folder is unknown or
		// the path escapes the project root. When `worktreeId` is set and the
		// worktree belongs to `folderId`, root-swaps to the worktree's path so
		// every fs surface (tree / read / write) follows the active session.
		// Shared by tree / readFile / writeFile so path-validation lives in
		// exactly one place.
		const resolveInsideFolder = (
			folderId: FolderId,
			relPath: string,
			worktreeId?: WorktreeId | null,
		) =>
			Effect.gen(function* () {
				const folder = yield* workspace.findById(folderId);
				if (folder === null) {
					return yield* Effect.fail(new FsFolderNotFoundError({ folderId }));
				}
				let rootPath = folder.path;
				if (worktreeId) {
					const wt = yield* worktrees.get(worktreeId);
					if (wt === null || wt.projectId !== folderId) {
						return yield* Effect.fail(
							new DirectoryUnavailableError({
								folderId,
								worktreeId,
								reason: "worktree-missing",
							}),
						);
					}
					rootPath = wt.path;
				}
				const rootExists = yield* fs
					.exists(rootPath)
					.pipe(Effect.orElseSucceed(() => false));
				if (!rootExists) {
					return yield* Effect.fail(
						new DirectoryUnavailableError({
							folderId,
							worktreeId: worktreeId ?? null,
							reason: worktreeId ? "worktree-missing" : "project-missing",
						}),
					);
				}
				const rootAbs = pathSvc.resolve(rootPath);
				const requestedAbs = pathSvc.resolve(rootAbs, relPath);
				const rel = pathSvc.relative(rootAbs, requestedAbs);
				if (rel.startsWith("..") || pathSvc.isAbsolute(rel)) {
					return yield* Effect.fail(
						new FsPathOutsideError({ folderId, path: relPath }),
					);
				}
				return { rootAbs, requestedAbs } as const;
			});

		const tree: FsService["Service"]["tree"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);

				const names = yield* fs.readDirectory(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);

				// Stat every entry in parallel — sequential stats blow up for any
				// folder with more than a few dozen files. A failed stat (broken
				// symlink, racey delete) just drops that entry so one bad child
				// doesn't blank the whole listing.
				const stats = yield* Effect.forEach(
					names,
					(name) =>
						Effect.gen(function* () {
							const entryAbs = pathSvc.join(requestedAbs, name);
							const stat = yield* fs.stat(entryAbs).pipe(Effect.option);
							if (stat._tag === "None") return null;
							const kind =
								stat.value.type === "Directory" ? "directory" : "file";
							if (kind === "directory" && SKIP_DIRS.has(name)) return null;
							const childRel = relPath === "" ? name : `${relPath}/${name}`;
							return FsEntry.make({
								name,
								path: toForwardSlash(childRel),
								kind,
							});
						}),
					{ concurrency: "unbounded" },
				);

				const entries = stats.filter((e): e is FsEntry => e !== null);
				// Dirs first, then files; case-insensitive within each group.
				entries.sort((a, b) => {
					if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
					return a.name.localeCompare(b.name, undefined, {
						sensitivity: "base",
					});
				});
				return entries;
			});

		const watchTree: FsService["Service"]["watchTree"] = (
			folderId,
			worktreeId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const { rootAbs } = yield* resolveInsideFolder(
						folderId,
						"",
						worktreeId,
					);
					const queue = yield* Queue.unbounded<FsTreeWatchEvent>();
					const state: TreeWatchState = { epoch: randomUUID(), sequence: 0 };
					const publish = (event: FsTreeWatchEvent): void => {
						Queue.offerUnsafe(queue, event);
					};

					let timer: ReturnType<typeof setTimeout> | null = null;
					const pending = new Set<string>();
					let handle: ReturnType<typeof watch> | null = null;
					let attached = false;
					let failedToAttach: Error | null = null;

					const flush = () => {
						timer = null;
						if (pending.size === 0) return;
						const paths = Array.from(pending);
						pending.clear();
						state.sequence += 1;
						publish(
							FsTreeWatchEvent.make({
								_tag: "changed",
								epoch: state.epoch,
								sequence: state.sequence,
								paths,
							}),
						);
					};

					const schedule = () => {
						if (timer !== null) clearTimeout(timer);
						timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
					};

					try {
						handle = watch(rootAbs, { recursive: true }, (_event, filename) => {
							if (filename === null) return;
							const rel = toForwardSlash(filename.toString());
							if (rel === "" || isSkippedWatchPath(rel)) return;
							pending.add(rel);
							schedule();
						});
						attached = true;
						handle.on("error", (err) => {
							// eslint-disable-next-line no-console
							console.warn("[fs.watchTree] fs.watch error:", err.message);
							state.sequence += 1;
							publish(
								FsTreeWatchEvent.make({
									_tag: "gap",
									epoch: state.epoch,
									sequence: state.sequence,
									reason: err.message,
								}),
							);
						});
					} catch (err) {
						failedToAttach =
							err instanceof Error ? err : new Error(String(err));
						// An unwatched tree cannot claim live continuity.
						// eslint-disable-next-line no-console
						console.warn(
							`[fs.watchTree] could not watch ${rootAbs}: ${(err as Error).message}`,
						);
						state.sequence += 1;
						publish(
							FsTreeWatchEvent.make({
								_tag: "gap",
								epoch: state.epoch,
								sequence: state.sequence,
								reason: (err as Error).message,
							}),
						);
					}

					if (attached) {
						Queue.offerUnsafe(
							queue,
							FsTreeWatchEvent.make({
								_tag: "ready",
								epoch: state.epoch,
								sequence: state.sequence,
							}),
						);
					}
					if (failedToAttach !== null) {
						return yield* Effect.fail(
							new FsReadError({
								folderId,
								path: "",
								reason: failedToAttach.message,
							}),
						);
					}

					yield* Effect.addFinalizer(() =>
						Effect.andThen(
							Effect.sync(() => {
								if (timer !== null) {
									clearTimeout(timer);
									timer = null;
								}
								handle?.close();
							}),
							Queue.shutdown(queue),
						),
					);

					return Stream.fromQueue(queue);
				}),
			);

		// Full recursive path listing for the `@pierre/trees` file tree. DFS with
		// dirs-first-then-name ordering so the result is already presorted
		// (parent before children) for `preparePresortedFileTreeInput`.
		// Directories carry a trailing "/" so empty ones still render. Bounded by
		// MAX_TREE_PATHS; a failed stat drops that entry rather than the branch.
		const listPaths: FsService["Service"]["listPaths"] = (
			folderId,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { rootAbs } = yield* resolveInsideFolder(
					folderId,
					"",
					worktreeId,
				);
				const out: string[] = [];
				let truncated = false;
				let estimatedBytes = 0;

				const walk = (
					absDir: string,
					relDir: string,
				): Effect.Effect<void, FsReadError> =>
					Effect.gen(function* () {
						if (truncated) return;
						const names = yield* fs.readDirectory(absDir).pipe(
							Effect.mapError(
								(cause) =>
									new FsReadError({
										folderId,
										path: relDir,
										reason: cause.message ?? String(cause),
									}),
							),
						);
						const rows = yield* Effect.forEach(
							names,
							(name) =>
								Effect.gen(function* () {
									const entryAbs = pathSvc.join(absDir, name);
									const stat = yield* fs.stat(entryAbs).pipe(Effect.option);
									if (stat._tag === "None") return null;
									const kind =
										stat.value.type === "Directory" ? "directory" : "file";
									if (kind === "directory" && SKIP_DIRS.has(name)) return null;
									const rel = relDir === "" ? name : `${relDir}/${name}`;
									return { name, kind, abs: entryAbs, rel } as const;
								}),
							{ concurrency: "unbounded" },
						);
						const valid = rows.filter(
							(r): r is NonNullable<typeof r> => r !== null,
						);
						valid.sort((a, b) => {
							if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
							return a.name.localeCompare(b.name, undefined, {
								sensitivity: "base",
							});
						});
						for (const row of valid) {
							if (out.length >= MAX_TREE_PATHS) {
								truncated = true;
								return;
							}
							const renderedPath =
								row.kind === "directory"
									? `${toForwardSlash(row.rel)}/`
									: toForwardSlash(row.rel);
							const renderedBytes = Buffer.byteLength(renderedPath) + 3;
							if (estimatedBytes + renderedBytes > MAX_TREE_PATH_BYTES) {
								truncated = true;
								return;
							}
							estimatedBytes += renderedBytes;
							if (row.kind === "directory") {
								out.push(renderedPath);
								yield* walk(row.abs, row.rel);
								if (truncated) return;
							} else {
								out.push(renderedPath);
							}
						}
					});

				yield* walk(rootAbs, "");
				return {
					paths: out,
					truncated,
				};
			});

		// Rename/move for the file tree's inline rename + drag-and-drop. Both
		// endpoints are containment-validated; refuses to clobber an existing dest.
		const move: FsService["Service"]["move"] = (
			folderId,
			fromPath,
			toPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const from = yield* resolveInsideFolder(folderId, fromPath, worktreeId);
				const to = yield* resolveInsideFolder(folderId, toPath, worktreeId);
				const destExists = yield* fs.stat(to.requestedAbs).pipe(Effect.option);
				if (destExists._tag === "Some") {
					return yield* Effect.fail(
						new FsAlreadyExistsError({ folderId, path: toPath }),
					);
				}
				yield* fs.rename(from.requestedAbs, to.requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: fromPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const readFile: FsService["Service"]["readFile"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);

				const stat = yield* fs.stat(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const size = Number(stat.size);
				if (size > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsTooLargeError({
							folderId,
							path: relPath,
							size,
							limit: MAX_FILE_BYTES,
						}),
					);
				}

				const bytes = yield* fs.readFile(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);

				// Decode strict-UTF-8. A failure means the file is binary — return
				// it as such so the editor can render a placeholder instead of
				// garbage. We don't attempt other encodings.
				try {
					const decoder = new TextDecoder("utf-8", { fatal: true });
					const content = decoder.decode(bytes);
					return {
						kind: "text" as const,
						content,
						mtime: mtimeToString(stat.mtime),
						size,
					};
				} catch {
					return { kind: "binary" as const, bytes, size };
				}
			});

		const writeFile: FsService["Service"]["writeFile"] = (
			commandId,
			folderId,
			relPath,
			content,
			expectedMtime,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const byteLen = new TextEncoder().encode(content).byteLength;
				if (byteLen > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsTooLargeError({
							folderId,
							path: relPath,
							size: byteLen,
							limit: MAX_FILE_BYTES,
						}),
					);
				}
				const normalizedPath = toForwardSlash(path.normalize(relPath));
				const contentHash = sha256(content);
				const worktreeIdentity = worktreeId ?? null;
				const logicalTarget = `${folderId}\0${worktreeIdentity ?? ""}\0${normalizedPath}`;

				return yield* writeSerial.run(
					logicalTarget,
					Effect.gen(function* () {
						const now = Date.now();
						const receipt = yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`
									DELETE FROM fs_write_receipts
									WHERE updated_at < ${now - FS_WRITE_RECEIPT_RETENTION_MS}
								`.pipe(Effect.orDie);
								yield* sql`
									DELETE FROM fs_write_receipts
									WHERE command_id IN (
										SELECT command_id FROM fs_write_receipts
										WHERE state = 'applied'
										ORDER BY updated_at DESC
										LIMIT -1 OFFSET ${MAX_APPLIED_FS_WRITE_RECEIPTS}
									)
								`.pipe(Effect.orDie);
								yield* sql`
									INSERT OR IGNORE INTO fs_write_receipts
										(command_id, folder_id, worktree_id, path, expected_mtime,
										 content_hash, state, mtime, created_at, updated_at)
									VALUES
										(${commandId}, ${folderId}, ${worktreeIdentity},
										 ${normalizedPath}, ${expectedMtime}, ${contentHash},
										 'prepared', NULL, ${now}, ${now})
								`.pipe(Effect.orDie);
								const rows = yield* sql<FsWriteReceipt>`
									SELECT folder_id, worktree_id, path, expected_mtime,
										content_hash, state, mtime
									FROM fs_write_receipts
									WHERE command_id = ${commandId}
									LIMIT 1
								`.pipe(Effect.orDie);
								return rows[0];
							}),
						);
						if (receipt === undefined) {
							return yield* Effect.die(
								`File command ${commandId} was not persisted`,
							);
						}
						const targetMatches =
							receipt.folder_id === folderId &&
							receipt.worktree_id === worktreeIdentity &&
							receipt.path === normalizedPath;
						if (!targetMatches) {
							return yield* Effect.fail(
								new FsCommandReuseError({
									commandId,
									reason: "target-mismatch",
								}),
							);
						}
						if (
							receipt.expected_mtime !== expectedMtime ||
							receipt.content_hash !== contentHash
						) {
							return yield* Effect.fail(
								new FsCommandReuseError({
									commandId,
									reason: "payload-mismatch",
								}),
							);
						}
						if (receipt.state === "applied") {
							if (receipt.mtime === null) {
								return yield* Effect.die(
									`Applied file command ${commandId} has no mtime`,
								);
							}
							return { mtime: receipt.mtime };
						}
						const { requestedAbs } = yield* resolveInsideFolder(
							folderId,
							relPath,
							worktreeId,
						);

						const beforeStat = yield* fs.stat(requestedAbs).pipe(
							Effect.mapError(
								(cause) =>
									new FsReadError({
										folderId,
										path: relPath,
										reason: cause.message ?? String(cause),
									}),
							),
						);
						const actualMtime = mtimeToString(beforeStat.mtime);
						let contentAlreadyApplied = false;
						if (Number(beforeStat.size) === byteLen) {
							const bytes = yield* fs.readFile(requestedAbs).pipe(
								Effect.mapError(
									(cause) =>
										new FsReadError({
											folderId,
											path: relPath,
											reason: cause.message ?? String(cause),
										}),
								),
							);
							contentAlreadyApplied = sha256(bytes) === contentHash;
						}

						if (!contentAlreadyApplied && actualMtime !== expectedMtime) {
							return yield* Effect.fail(
								new FsConflictError({
									folderId,
									path: relPath,
									expectedMtime,
									actualMtime,
								}),
							);
						}

						let appliedMtime = actualMtime;
						if (!contentAlreadyApplied) {
							const temporary = pathSvc.join(
								pathSvc.dirname(requestedAbs),
								`.${pathSvc.basename(requestedAbs)}.zuse-write-${sha256(commandId).slice(0, 16)}`,
							);
							yield* Effect.acquireUseRelease(
								Effect.succeed(temporary),
								(tempPath) =>
									Effect.gen(function* () {
										yield* fs.writeFileString(tempPath, content);
										yield* fs.chmod(tempPath, beforeStat.mode);
										yield* fs.rename(tempPath, requestedAbs);
									}).pipe(
										Effect.mapError(
											(cause) =>
												new FsReadError({
													folderId,
													path: relPath,
													reason: cause.message ?? String(cause),
												}),
										),
									),
								(tempPath) =>
									fs.remove(tempPath, { force: true }).pipe(Effect.ignore),
							);
							const afterStat = yield* fs.stat(requestedAbs).pipe(
								Effect.mapError(
									(cause) =>
										new FsReadError({
											folderId,
											path: relPath,
											reason: cause.message ?? String(cause),
										}),
								),
							);
							appliedMtime = mtimeToString(afterStat.mtime);
						}

						return yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`
									UPDATE fs_write_receipts
									SET state = 'applied', mtime = ${appliedMtime},
										updated_at = ${Date.now()}
									WHERE command_id = ${commandId} AND state = 'prepared'
								`.pipe(Effect.orDie);
								const finalized = yield* sql<{ readonly mtime: string | null }>`
									SELECT mtime FROM fs_write_receipts
									WHERE command_id = ${commandId} AND state = 'applied'
									LIMIT 1
								`.pipe(Effect.orDie);
								const mtime = finalized[0]?.mtime;
								if (mtime === undefined || mtime === null) {
									return yield* Effect.die(
										`File command ${commandId} could not be finalized`,
									);
								}
								return { mtime };
							}),
						);
					}).pipe(Effect.catchTag("SqlError", Effect.die)),
				);
			});

		const createFile: FsService["Service"]["createFile"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);
				const existing = yield* fs.stat(requestedAbs).pipe(Effect.option);
				if (existing._tag === "Some") {
					return yield* Effect.fail(
						new FsAlreadyExistsError({ folderId, path: relPath }),
					);
				}
				yield* fs.writeFileString(requestedAbs, "").pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const createDirectory: FsService["Service"]["createDirectory"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);
				const existing = yield* fs.stat(requestedAbs).pipe(Effect.option);
				if (existing._tag === "Some") {
					return yield* Effect.fail(
						new FsAlreadyExistsError({ folderId, path: relPath }),
					);
				}
				yield* fs.makeDirectory(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const remove: FsService["Service"]["remove"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);
				yield* fs.remove(requestedAbs, { recursive: true }).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		// External (outside-folder) read/write. Same decode / size-cap / mtime
		// concurrency as readFile/writeFile, but the path is absolute and there's
		// no folder containment check — deliberately so, to open files the agent
		// wrote elsewhere on disk. Errors key off `path` instead of `folderId`.
		const readExternal: FsService["Service"]["readExternal"] = (absPath) =>
			Effect.gen(function* () {
				const target = pathSvc.resolve(absPath);
				const stat = yield* fs.stat(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const size = Number(stat.size);
				if (size > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsExternalTooLargeError({
							path: absPath,
							size,
							limit: MAX_FILE_BYTES,
						}),
					);
				}
				const bytes = yield* fs.readFile(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				try {
					const decoder = new TextDecoder("utf-8", { fatal: true });
					const content = decoder.decode(bytes);
					return {
						kind: "text" as const,
						content,
						mtime: mtimeToString(stat.mtime),
						size,
					};
				} catch {
					return { kind: "binary" as const, bytes, size };
				}
			});

		const writeExternal: FsService["Service"]["writeExternal"] = (
			absPath,
			content,
			expectedMtime,
		) =>
			Effect.gen(function* () {
				const target = pathSvc.resolve(absPath);
				const byteLen = new TextEncoder().encode(content).byteLength;
				if (byteLen > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsExternalTooLargeError({
							path: absPath,
							size: byteLen,
							limit: MAX_FILE_BYTES,
						}),
					);
				}
				const beforeStat = yield* fs.stat(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const actualMtime = mtimeToString(beforeStat.mtime);
				if (actualMtime !== expectedMtime) {
					return yield* Effect.fail(
						new FsExternalConflictError({
							path: absPath,
							expectedMtime,
							actualMtime,
						}),
					);
				}
				yield* fs.writeFileString(target, content).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const afterStat = yield* fs.stat(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return { mtime: mtimeToString(afterStat.mtime) };
			});

		return {
			tree,
			watchTree,
			listPaths,
			move,
			readFile,
			writeFile,
			createFile,
			createDirectory,
			remove,
			readExternal,
			writeExternal,
		} as const;
	}),
);
