import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	type MemoryScope,
	type MemoryVault,
	makeMemoryVault,
} from "../../src/context/memory-vault.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const fixture = (): string => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-memory-vault-"));
	temporaryDirectories.push(directory);
	return directory;
};

/**
 * Vault factory mirroring the server layout:
 * `<root>/memory/<projectId>/project` and `.../sessions/<sessionId>`.
 */
const vaultFor = (
	root: string,
	projectId: string | null,
	sessionId: string,
): Effect.Effect<MemoryVault> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;
		return makeMemoryVault({
			fs,
			path: pathSvc,
			sourceSession: sessionId,
			scopeDir: (scope: MemoryScope) => {
				if (projectId === null) return Effect.succeed(null);
				const base = pathSvc.join(root, "memory", projectId);
				return Effect.succeed(
					scope === "session"
						? pathSvc.join(base, "sessions", sessionId)
						: pathSvc.join(base, "project"),
				);
			},
		});
	}).pipe(Effect.provide(NodeServices.layer));

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
	Effect.runPromise(effect);

describe("memory vault", () => {
	it("writes a note file and indexes it in MEMORY.md", async () => {
		const root = fixture();
		const note = await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				const written = yield* vault.write({
					title: "Build uses bun",
					text: "Run `bun install` before anything else.",
				});
				return written;
			}),
		);
		expect(note.note).toMatch(/^\d{2}-build-uses-bun$/);
		const file = readFileSync(
			join(root, "memory", "proj_a", "project", `${note.note}.md`),
			"utf8",
		);
		expect(file).toContain("# Build uses bun");
		expect(file).toContain("scope: project");
		expect(file).toContain("session: s1");
	});

	it("returns an empty index for a fresh vault", async () => {
		const root = fixture();
		const result = await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				return yield* vault.read();
			}),
		);
		expect(result.content).toContain("no notes yet");
	});

	it("reads a note by name and rejects unsafe names", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				yield* vault.write({ title: "Ports", text: "API runs on 8787." });
				const result = yield* vault.read({ note: "01-ports" });
				expect(result.content).toContain("8787");
				const bad = yield* vault.read({ note: "../x" }).pipe(Effect.flip);
				expect(bad._tag).toBe("MemoryVaultError");
			}),
		);
	});

	it("searches note contents case-insensitively", async () => {
		const root = fixture();
		const hits = await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				yield* vault.write({ title: "Auth flow", text: "DPoP-bound tokens." });
				return yield* vault.search({ query: "dpop" });
			}),
		);
		expect(hits.hits).toHaveLength(1);
		expect(hits.hits[0]?.scope).toBe("project");
	});

	it("acceptance: memory written in one workspace is readable from another", async () => {
		// Session s1 in worktree A writes; session s2 in a different worktree
		// for the SAME project reads it — the maintainer's acceptance case.
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const a = yield* vaultFor(root, "proj_a", "s1");
				yield* a.write({
					title: "Port choice",
					text: "Use 8787 for the local server.",
				});
				const b = yield* vaultFor(root, "proj_a", "s2");
				const result = yield* b.read({ note: "01-port-choice" });
				expect(result.content).toContain("8787");
				const hits = yield* b.search({ query: "port" });
				expect(hits.hits.length).toBeGreaterThan(0);
			}),
		);
	});

	it("isolates memory between projects", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const a = yield* vaultFor(root, "proj_a", "s1");
				yield* a.write({ title: "Secret layout", text: "proj_a layout." });
				const b = yield* vaultFor(root, "proj_b", "s9");
				const index = yield* b.read();
				expect(index.content).not.toContain("Secret layout");
				const miss = yield* b
					.read({ note: "01-secret-layout" })
					.pipe(Effect.flip);
				expect(miss._tag).toBe("MemoryVaultError");
			}),
		);
	});

	it("keeps session-scoped notes private to the writing session", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const a = yield* vaultFor(root, "proj_a", "s1");
				yield* a.write({
					title: "Scratch",
					text: "Session-only scratch.",
					scope: "session",
				});
				// s2's session scope is a different directory — must not see it.
				const b = yield* vaultFor(root, "proj_a", "s2");
				const sessionIndex = yield* b.read({ scope: "session" });
				expect(sessionIndex.content).not.toContain("Scratch");
				// ...but scope "all" sees project notes + s2's own session notes.
				const all = yield* b.read({ scope: "all" });
				expect(all.content).toContain("Project memory");
				expect(all.content).toContain("Session memory");
				// s1 reading its own session scope does see it.
				const own = yield* a.read({ scope: "session" });
				expect(own.content).toContain("Scratch");
			}),
		);
	});

	it("search with scope 'all' covers both vaults and tags hits", async () => {
		const root = fixture();
		const hits = await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				yield* vault.write({ title: "Shared", text: "in project vault." });
				yield* vault.write({
					title: "Private",
					text: "in session vault.",
					scope: "session",
				});
				return yield* vault.search({ query: "vault", scope: "all" });
			}),
		);
		const scopes = new Set(hits.hits.map((hit) => hit.scope));
		expect(scopes).toEqual(new Set(["project", "session"]));
	});

	it("serializes concurrent writes across vault instances of one project", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				// Two sessions, same project → two MemoryVault instances over one
				// directory. Concurrent writes must get distinct note numbers.
				const a = yield* vaultFor(root, "proj_a", "s1");
				const b = yield* vaultFor(root, "proj_a", "s2");
				const [w1, w2, w3] = yield* Effect.all(
					[
						a.write({ title: "first", text: "one" }),
						b.write({ title: "second", text: "two" }),
						a.write({ title: "third", text: "three" }),
					],
					{ concurrency: "unbounded" },
				);
				const names = [w1.note, w2.note, w3.note];
				expect(new Set(names).size).toBe(3);
				const index = yield* b.read();
				for (const note of names) {
					expect(index.content).toContain(note);
				}
			}),
		);
	});

	it("marks a note verified and reports status in search hits", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				const { note } = yield* vault.write({
					title: "vetted fact",
					text: "the provider cache lives in userData",
				});
				// Fresh notes are pending.
				let hits = (yield* vault.search({ query: "vetted" })).hits;
				expect(hits[0]?.status).toBe("pending");
				// Verify flips it.
				const verified = yield* vault.verify({ note });
				expect(verified.status).toBe("verified");
				hits = (yield* vault.search({ query: "vetted" })).hits;
				expect(hits[0]?.status).toBe("verified");
				// Verify is idempotent.
				expect((yield* vault.verify({ note })).status).toBe("verified");
			}),
		);
	});

	it("rejects verifying a missing or unsafe note name", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				const missing = yield* vault
					.verify({ note: "99-nope" })
					.pipe(Effect.flip);
				expect(missing.reason).toContain("No memory note");
				const unsafe = yield* vault
					.verify({ note: "../escape" })
					.pipe(Effect.flip);
				expect(unsafe.reason).toContain("Invalid note name");
			}),
		);
	});

	it("keeps a git history of the vault directory", async () => {
		const root = fixture();
		await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, "proj_a", "s1");
				yield* vault.write({ title: "one", text: "first" });
				yield* vault.write({ title: "two", text: "second" });
			}),
		);
		const dir = `${root}/memory/proj_a/project`;
		// Best-effort feature: skip if git is unavailable in this env.
		try {
			execFileSync("git", ["--version"]);
		} catch {
			return;
		}
		expect(existsSync(`${dir}/.git`)).toBe(true);
		const log = execFileSync("git", ["-C", dir, "log", "--oneline"], {
			encoding: "utf8",
		});
		expect(log).toContain("memory: write 01-one");
		expect(log).toContain("memory: write 02-two");
	});

	it("reports an error when no project resolves", async () => {
		const root = fixture();
		const error = await run(
			Effect.gen(function* () {
				const vault = yield* vaultFor(root, null, "s1");
				return yield* vault.write({ title: "x", text: "y" }).pipe(Effect.flip);
			}),
		);
		expect((error as { reason: string }).reason).toContain("No project");
	});
});
