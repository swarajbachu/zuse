import { createHash } from "node:crypto";
import {
	closeSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { observeWorkspaceFingerprintPaths } from "../../src/workspace-fingerprint.ts";

const temporaryRoots: string[] = [];
const makeTemporaryRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "zuse-workspace-fingerprint-"));
	temporaryRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("workspace fingerprint observation", () => {
	it("stats but never reads a 512 MiB changed file", async () => {
		const root = makeTemporaryRoot();
		const file = join(root, "large.bin");
		const fd = openSync(file, "w");
		ftruncateSync(fd, 512 * 1024 * 1024);
		closeSync(fd);
		let hashCalls = 0;
		const startedAt = performance.now();

		const observation = await Effect.runPromise(
			observeWorkspaceFingerprintPaths(root, ["large.bin"], () => {
				hashCalls += 1;
				return Effect.succeed("");
			}),
		);

		expect(performance.now() - startedAt).toBeLessThan(500);
		expect(hashCalls).toBe(0);
		expect(observation.pathMetadata).toHaveLength(1);
		expect(observation.coverageNonce).toBeNull();
	});

	it("detects an oversized same-size edit even when mtime is restored", async () => {
		const root = makeTemporaryRoot();
		const file = join(root, "oversized.bin");
		const fd = openSync(file, "w");
		ftruncateSync(fd, 9 * 1024 * 1024);
		writeSync(fd, Buffer.from("a"), 0, 1, 0);
		closeSync(fd);
		const original = statSync(file);
		const observe = () =>
			Effect.runPromise(
				observeWorkspaceFingerprintPaths(root, ["oversized.bin"], () =>
					Effect.fail(new Error("oversized files must not be hashed")),
				),
			);

		const before = await observe();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const changed = openSync(file, "r+");
		writeSync(changed, Buffer.from("b"), 0, 1, 0);
		closeSync(changed);
		utimesSync(file, original.atime, original.mtime);
		const after = await observe();

		expect(after.coverageNonce).toBeNull();
		expect(JSON.stringify(after.pathMetadata)).not.toBe(
			JSON.stringify(before.pathMetadata),
		);
	});

	it("falls back per file when one disappearing path breaks a hash batch", async () => {
		const root = makeTemporaryRoot();
		for (const path of ["a.txt", "gone.txt", "b.txt"]) {
			writeFileSync(join(root, path), `${path}\n`);
		}
		const calls: ReadonlyArray<string>[] = [];
		const hashPaths = (paths: ReadonlyArray<string>) =>
			Effect.try({
				try: () => {
					calls.push([...paths]);
					if (paths.length > 1) {
						unlinkSync(join(root, "gone.txt"));
						throw new Error("batch invalidated");
					}
					return `${createHash("sha256")
						.update(readFileSync(join(root, paths[0] as string)))
						.digest("hex")}\n`;
				},
				catch: (cause) => cause,
			});

		const observation = await Effect.runPromise(
			observeWorkspaceFingerprintPaths(
				root,
				["a.txt", "gone.txt", "b.txt"],
				hashPaths,
				{ nonce: () => "incomplete-observation" },
			),
		);

		expect(calls).toEqual([
			["a.txt", "gone.txt", "b.txt"],
			["a.txt"],
			["gone.txt"],
			["b.txt"],
		]);
		expect(observation.contentHashes).toEqual([
			["a.txt", expect.any(String)],
			["gone.txt", "unavailable"],
			["b.txt", expect.any(String)],
		]);
		expect(observation.coverageNonce).toBe("incomplete-observation");
	});
});
