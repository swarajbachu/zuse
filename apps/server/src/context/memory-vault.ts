import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Data, Effect, type FileSystem, type Path } from "effect";

/**
 * Project-keyed agent memory vault: a directory of Markdown notes under
 * `<userData>/memory/<projectId>/`. The `project` scope is shared by every
 * session and worktree of the project — it survives worktree archive and
 * deletion — while the `session` scope keeps notes private to one session
 * under `sessions/<sessionId>/`. `MEMORY.md` is the index — one
 * `- [[NN-<slug>]] — <title>` line per note — and each note is a standalone
 * `NN-<slug>.md` file stamped with provenance frontmatter (`created`,
 * `session`, `scope`). Notes are context, not instructions.
 *
 * The vault takes service *instances* so the orchestration layer can bind
 * `FileSystem` / `Path` captured at layer-construction time. `scopeDir`
 * resolves lazily per call so a session's project is looked up when the
 * tool fires, not when it is registered.
 */

export class MemoryVaultError extends Data.TaggedError("MemoryVaultError")<{
	readonly reason: string;
}> {}

/** Where a note lives. `project` outlives worktrees; `session` is private. */
export type MemoryScope = "project" | "session";
/** Read and search can fan out across both scopes. */
export type MemoryReadScope = MemoryScope | "all";

/**
 * Notes land as `pending` (fresh, unvetted) and can be flipped to `verified`
 * via `memory_verify` once reviewed — search hits carry it so agents can see
 * which memories are trusted.
 */
export type MemoryNoteStatus = "pending" | "verified";

export interface MemorySearchHit {
	readonly note: string;
	readonly line: number;
	readonly text: string;
	readonly scope: MemoryScope;
	readonly status: MemoryNoteStatus;
}

export interface MemoryVault {
	readonly write: (input: {
		readonly title: string;
		readonly text: string;
		readonly scope?: MemoryScope;
	}) => Effect.Effect<{ readonly note: string }, MemoryVaultError>;
	readonly read: (input?: {
		readonly note?: string;
		readonly scope?: MemoryReadScope;
	}) => Effect.Effect<
		{ readonly note: string | null; readonly content: string },
		MemoryVaultError
	>;
	readonly search: (input: {
		readonly query: string;
		readonly scope?: MemoryReadScope;
	}) => Effect.Effect<
		{ readonly hits: ReadonlyArray<MemorySearchHit> },
		MemoryVaultError
	>;
	readonly verify: (input: {
		readonly note: string;
		readonly scope?: MemoryScope;
	}) => Effect.Effect<
		{ readonly note: string; readonly status: MemoryNoteStatus },
		MemoryVaultError
	>;
}

const MEMORY_INDEX = "MEMORY.md";
const SEARCH_HIT_LIMIT = 50;

const EMPTY_INDEX = "# Memory Index\n\n(no notes yet)\n";
const INDEX_HEADER = "# Memory Index\n";

/** Notes are `NN-<slug>.md` — strict charset keeps names path-safe. */
const NOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NOTE_FILE_PATTERN = /^(\d+)-([A-Za-z0-9_-]*)\.md$/;

const slugFor = (title: string): string => {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "note";
};

/**
 * Resolve a `note` argument to a filename without `.md`. Accepts an optional
 * trailing `.md`; anything else (`../x`, slashes, empty) is rejected.
 */
const safeNoteName = (raw: string): string | null => {
	const name = raw.endsWith(".md") ? raw.slice(0, -".md".length) : raw;
	return NOTE_NAME_PATTERN.test(name) ? name : null;
};

/**
 * Per-directory write queues shared by every vault instance in this process.
 * Two sessions of the same project hold different `MemoryVault` objects over
 * the same directory — without serialization they could pick the same note
 * number and rewrite `MEMORY.md` from a stale copy. Each `write` chains onto
 * the directory's queue so note selection and the index update are atomic.
 * This is in-process only; two servers sharing one `userData` directory is
 * not a supported deployment.
 */
const runGit = promisify(execFile);

/**
 * Version the vault directory in-place (Codex keeps its memory dir git-
 * versioned). `init` runs once per directory with a local identity, then each
 * write/verify commits its own change so `git log` gives note history. Fully
 * best-effort: no git binary, no commits — the vault still works.
 */
const versionVault = async (dir: string, message: string): Promise<void> => {
	const inRepo = await runGit("git", [
		"-C",
		dir,
		"rev-parse",
		"--is-inside-work-tree",
	]).then(
		() => true,
		() => false,
	);
	if (!inRepo) {
		await runGit("git", ["-C", dir, "init", "-q"]);
		await runGit("git", ["-C", dir, "config", "user.name", "zuse"]);
		await runGit("git", ["-C", dir, "config", "user.email", "zuse@local"]);
		await runGit("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
	}
	await runGit("git", ["-C", dir, "add", "-A"]);
	// "nothing to commit" exits non-zero — that is not a failure worth surfacing.
	await runGit("git", [
		"-C",
		dir,
		"commit",
		"-qm",
		message,
		"--no-verify",
	]).catch(() => {});
};

const commitWrite = (dir: string, message: string): Effect.Effect<void> =>
	Effect.promise(() => versionVault(dir, message)).pipe(
		Effect.catch(() => Effect.void),
	);

const STATUS_PATTERN = /^status: (pending|verified)$/m;

const noteStatus = (content: string): MemoryNoteStatus =>
	STATUS_PATTERN.exec(content)?.[1] === "verified" ? "verified" : "pending";

const dirWriteQueues = new Map<string, Promise<unknown>>();

const enqueueWrite = <A>(dir: string, run: () => Promise<A>): Promise<A> => {
	const queued = (dirWriteQueues.get(dir) ?? Promise.resolve()).then(run);
	dirWriteQueues.set(
		dir,
		queued.then(
			() => undefined,
			() => undefined,
		),
	);
	return queued;
};

export const makeMemoryVault = (options: {
	readonly fs: FileSystem.FileSystem;
	readonly path: Path.Path;
	readonly scopeDir: (
		scope: MemoryScope,
	) => Effect.Effect<string | null, MemoryVaultError>;
	readonly sourceSession?: string;
}): MemoryVault => {
	const { fs, path: pathSvc, scopeDir } = options;

	/**
	 * Run an effect inside the directory's write queue. Errors from prior
	 * queued writes never poison the queue, and the effect's own error type
	 * is preserved via `Effect.result`.
	 */
	const withWriteLock = <A>(
		dir: string,
		effect: Effect.Effect<A, MemoryVaultError>,
	): Effect.Effect<A, MemoryVaultError> =>
		Effect.flatMap(
			Effect.promise(() =>
				enqueueWrite(dir, () => Effect.runPromise(Effect.result(effect))),
			),
			(result) =>
				result._tag === "Failure"
					? Effect.fail(result.failure)
					: Effect.succeed(result.success),
		);

	const dirFor = (
		scope: MemoryScope,
	): Effect.Effect<string, MemoryVaultError> =>
		Effect.gen(function* () {
			const dir = yield* scopeDir(scope);
			if (dir === null) {
				return yield* new MemoryVaultError({
					reason:
						"No project is resolved for this session, so there is no memory vault to write to.",
				});
			}
			yield* fs.makeDirectory(dir, { recursive: true }).pipe(
				Effect.mapError(
					(error) =>
						new MemoryVaultError({
							reason: `Could not create the memory vault: ${String(error.reason ?? error)}`,
						}),
				),
			);
			return dir;
		});

	const listNoteFiles = (dir: string) =>
		fs.readDirectory(dir).pipe(
			Effect.map((names) =>
				names.filter((name) => NOTE_FILE_PATTERN.test(name)).sort(),
			),
			Effect.mapError(
				(error) =>
					new MemoryVaultError({
						reason: `Could not list memory notes: ${String(error.reason ?? error)}`,
					}),
			),
		);

	const readFile = (path: string) =>
		fs.readFileString(path).pipe(
			Effect.mapError(
				(error) =>
					new MemoryVaultError({
						reason: `Could not read ${pathSvc.basename(path)}: ${String(error.reason ?? error)}`,
					}),
			),
		);

	const readIndex = (dir: string) =>
		Effect.gen(function* () {
			const indexPath = pathSvc.join(dir, MEMORY_INDEX);
			return (yield* fs
				.exists(indexPath)
				.pipe(Effect.orElseSucceed(() => false)))
				? yield* readFile(indexPath)
				: EMPTY_INDEX;
		});

	const frontmatter = (scope: MemoryScope): string =>
		[
			"---",
			`created: ${new Date().toISOString()}`,
			`session: ${options.sourceSession ?? "unknown"}`,
			`scope: ${scope}`,
			"status: pending",
			"---",
			"",
		].join("\n");

	const write = (input: {
		readonly title: string;
		readonly text: string;
		readonly scope?: MemoryScope;
	}): Effect.Effect<{ readonly note: string }, MemoryVaultError> =>
		Effect.gen(function* () {
			const scope = input.scope ?? "project";
			const dir = yield* dirFor(scope);
			return yield* withWriteLock(
				dir,
				Effect.gen(function* () {
					const existing = yield* listNoteFiles(dir);
					const next =
						existing.reduce((max, name) => {
							const index = Number.parseInt(
								NOTE_FILE_PATTERN.exec(name)?.[1] ?? "",
								10,
							);
							return Number.isNaN(index) ? max : Math.max(max, index);
						}, 0) + 1;
					const note = `${String(next).padStart(2, "0")}-${slugFor(input.title)}`;
					yield* fs
						.writeFileString(
							pathSvc.join(dir, `${note}.md`),
							`${frontmatter(scope)}# ${input.title}\n\n${input.text}\n`,
						)
						.pipe(
							Effect.mapError(
								(error) =>
									new MemoryVaultError({
										reason: `Could not write memory note: ${String(error.reason ?? error)}`,
									}),
							),
						);
					const indexPath = pathSvc.join(dir, MEMORY_INDEX);
					const index = yield* readIndex(dir).pipe(
						Effect.catch(() => Effect.succeed(INDEX_HEADER)),
					);
					const entry = `- [[${note}]] — ${input.title}`;
					const body = index.endsWith("\n") ? index : `${index}\n`;
					yield* fs.writeFileString(indexPath, `${body}${entry}\n`).pipe(
						Effect.mapError(
							(error) =>
								new MemoryVaultError({
									reason: `Could not update ${MEMORY_INDEX}: ${String(error.reason ?? error)}`,
								}),
						),
					);
					yield* commitWrite(dir, `memory: write ${note} (${scope})`);
					return { note };
				}),
			);
		});

	const readFromDir = (
		dir: string,
		note: string | undefined,
	): Effect.Effect<
		{ readonly note: string | null; readonly content: string },
		MemoryVaultError
	> =>
		Effect.gen(function* () {
			if (note === undefined) {
				return { note: null, content: yield* readIndex(dir) };
			}
			const name = safeNoteName(note);
			if (name === null) {
				return yield* new MemoryVaultError({
					reason: `Invalid note name: ${note}`,
				});
			}
			const notePath = pathSvc.join(dir, `${name}.md`);
			if (
				!(yield* fs.exists(notePath).pipe(Effect.orElseSucceed(() => false)))
			) {
				return yield* new MemoryVaultError({
					reason: `No memory note named ${note}.`,
				});
			}
			return { note: name, content: yield* readFile(notePath) };
		});

	const read = (input?: {
		readonly note?: string;
		readonly scope?: MemoryReadScope;
	}): Effect.Effect<
		{ readonly note: string | null; readonly content: string },
		MemoryVaultError
	> =>
		Effect.gen(function* () {
			const scope = input?.scope ?? "project";
			if (scope === "all") {
				// Index read returns both indexes side by side; a named note is
				// looked up in the project scope first, then the session scope.
				const projectDir = yield* dirFor("project");
				if (input?.note === undefined) {
					const sessionDir = yield* scopeDir("session");
					const projectIndex = yield* readIndex(projectDir);
					const sessionIndex =
						sessionDir === null ||
						!(yield* fs
							.exists(sessionDir)
							.pipe(Effect.orElseSucceed(() => false)))
							? EMPTY_INDEX
							: yield* readIndex(sessionDir);
					return {
						note: null,
						content: `## Project memory\n\n${projectIndex}\n## Session memory\n\n${sessionIndex}`,
					};
				}
				const name = safeNoteName(input.note);
				if (name === null) {
					return yield* new MemoryVaultError({
						reason: `Invalid note name: ${input.note}`,
					});
				}
				const projectPath = pathSvc.join(projectDir, `${name}.md`);
				if (
					yield* fs.exists(projectPath).pipe(Effect.orElseSucceed(() => false))
				) {
					return { note: name, content: yield* readFile(projectPath) };
				}
				const sessionDir = yield* scopeDir("session");
				if (sessionDir === null) {
					return yield* new MemoryVaultError({
						reason: `No memory note named ${input.note}.`,
					});
				}
				return yield* readFromDir(sessionDir, name);
			}
			const dir = yield* dirFor(scope);
			return yield* readFromDir(dir, input?.note);
		});

	const searchInDir = (
		dir: string,
		scope: MemoryScope,
		query: string,
		hits: MemorySearchHit[],
	): Effect.Effect<void, MemoryVaultError> =>
		Effect.gen(function* () {
			const names = (yield* fs
				.readDirectory(dir)
				.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))).filter(
				(name) => name.endsWith(".md"),
			);
			for (const name of names) {
				if (hits.length >= SEARCH_HIT_LIMIT) break;
				const content = yield* fs
					.readFileString(pathSvc.join(dir, name))
					.pipe(Effect.orElseSucceed(() => ""));
				const note = name.slice(0, -".md".length);
				const status = noteStatus(content);
				const lines = content.split("\n");
				for (const [index, line] of lines.entries()) {
					if (hits.length >= SEARCH_HIT_LIMIT) break;
					if (line.toLowerCase().includes(query)) {
						hits.push({
							note,
							line: index + 1,
							text: line.trim(),
							scope,
							status,
						});
					}
				}
			}
		});

	const search = (input: {
		readonly query: string;
		readonly scope?: MemoryReadScope;
	}): Effect.Effect<
		{ readonly hits: ReadonlyArray<MemorySearchHit> },
		MemoryVaultError
	> =>
		Effect.gen(function* () {
			const query = input.query.trim().toLowerCase();
			if (query.length === 0) {
				return yield* new MemoryVaultError({
					reason: "memory_search requires a non-empty query.",
				});
			}
			const scope = input.scope ?? "project";
			const hits: MemorySearchHit[] = [];
			const scopes: MemoryScope[] =
				scope === "all" ? ["project", "session"] : [scope];
			for (const each of scopes) {
				if (hits.length >= SEARCH_HIT_LIMIT) break;
				// A scope with no project resolved has no vault — skip it so
				// searching "all" still works on sessions without a session dir.
				const dir = yield* scopeDir(each);
				if (dir === null) continue;
				yield* searchInDir(dir, each, query, hits);
			}
			return { hits };
		});

	const verify = (input: {
		readonly note: string;
		readonly scope?: MemoryScope;
	}): Effect.Effect<
		{ readonly note: string; readonly status: MemoryNoteStatus },
		MemoryVaultError
	> =>
		Effect.gen(function* () {
			const scope = input.scope ?? "project";
			const dir = yield* dirFor(scope);
			return yield* withWriteLock(
				dir,
				Effect.gen(function* () {
					const name = safeNoteName(input.note);
					if (name === null) {
						return yield* new MemoryVaultError({
							reason: `Invalid note name: ${input.note}`,
						});
					}
					const notePath = pathSvc.join(dir, `${name}.md`);
					if (
						!(yield* fs
							.exists(notePath)
							.pipe(Effect.orElseSucceed(() => false)))
					) {
						return yield* new MemoryVaultError({
							reason: `No memory note named ${input.note} in ${scope} scope.`,
						});
					}
					const content = yield* readFile(notePath);
					if (noteStatus(content) === "verified") {
						return { note: name, status: "verified" as const };
					}
					const stamped = content.replace(STATUS_PATTERN, "status: verified");
					if (stamped === content) {
						// Old-format note without a status line: stamp one into the
						// frontmatter if present, else refuse rather than guess.
						const withStatus = content.replace(
							/^(---\n(?:.*\n)*?)(---)/,
							"$1status: verified\n$2",
						);
						if (withStatus === content) {
							return yield* new MemoryVaultError({
								reason: `Note ${name} has no frontmatter to update.`,
							});
						}
						yield* fs.writeFileString(notePath, withStatus).pipe(
							Effect.mapError(
								(error) =>
									new MemoryVaultError({
										reason: `Could not verify note: ${String(error.reason ?? error)}`,
									}),
							),
						);
					} else {
						yield* fs.writeFileString(notePath, stamped).pipe(
							Effect.mapError(
								(error) =>
									new MemoryVaultError({
										reason: `Could not verify note: ${String(error.reason ?? error)}`,
									}),
							),
						);
					}
					yield* commitWrite(dir, `memory: verify ${name} (${scope})`);
					return { note: name, status: "verified" as const };
				}),
			);
		});

	return { write, read, search, verify };
};
