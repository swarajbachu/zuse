import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { PermissionAuditLogLive } from "../../src/provider/layers/permission-audit.ts";
import {
	type PermissionAuditEntry,
	PermissionAuditLog,
} from "../../src/provider/services/permission-audit.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const entry: PermissionAuditEntry = {
	at: "2026-01-01T00:00:01.000Z",
	requestId: "pr_1",
	sessionId: "session-1",
	chatId: "chat-1",
	projectId: "project-1",
	worktreeId: "wt-1",
	providerId: "claude",
	kind: "Bash",
	tool: null,
	decision: "AlwaysAllow",
	scope: "folder",
	target: "rm -rf build",
	forcePrompt: false,
	requestedAt: "2026-01-01T00:00:00.000Z",
};

const readLines = (userData: string): unknown[] =>
	readFileSync(join(userData, "audit", "permission-grants.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

const withLog = <A>(
	userData: string,
	use: (log: PermissionAuditLog["Service"]) => Effect.Effect<A>,
) =>
	Effect.runPromise(
		Effect.flatMap(PermissionAuditLog, use).pipe(
			Effect.provide(
				PermissionAuditLogLive.pipe(
					Layer.provide(Layer.succeed(AppPaths, { userData })),
				),
			),
		),
	);

describe("PermissionAuditLog", () => {
	test("appends one JSON object per record call", async () => {
		const userData = mkdtempSync(join(tmpdir(), "zuse-audit-"));
		directories.push(userData);
		await withLog(userData, (log) =>
			Effect.gen(function* () {
				yield* log.record(entry);
				yield* log.record({ ...entry, requestId: "pr_2", decision: "Deny" });
			}),
		);
		expect(readLines(userData)).toEqual([
			entry,
			{ ...entry, requestId: "pr_2", decision: "Deny" },
		]);
	});

	test("a broken sink never fails the caller", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-audit-broken-"));
		directories.push(directory);
		// userData as a regular file makes the audit/ mkdir fail (ENOTDIR).
		const userData = join(directory, "not-a-directory");
		writeFileSync(userData, "occupied");
		await withLog(userData, (log) => log.record(entry));
		expect(existsSync(join(userData, "audit"))).toBe(false);
	});
});
