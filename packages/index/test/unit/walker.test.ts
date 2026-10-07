import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { streamRepo, walkRepo } from "../../src/walker.ts";

it("streams bounded contents, ignores binaries and symlinks, preserves collector", async () => {
	const root = await mkdtemp(join(tmpdir(), "index-walker-"));
	try {
		await writeFile(join(root, "a.ts"), "hello");
		await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
		await symlink("/etc/passwd", join(root, "escape"));
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, "node_modules", "ignored"), "skip");
		const files = await Effect.runPromise(walkRepo(root));
		expect(files.map((file) => file.relPath)).toEqual(["a.ts"]);
		expect(files[0]?.bytes.toString()).toBe("hello");
		const iterator = streamRepo(root, { maxTotalBytes: 4 });
		await expect(iterator.next()).rejects.toMatchObject({
			reason: "repository indexing limit exceeded",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("rejects limits and closes early iteration without retaining later contents", async () => {
	const root = await mkdtemp(join(tmpdir(), "index-walker-"));
	try {
		await writeFile(join(root, "a.ts"), "a");
		await writeFile(join(root, "b.ts"), "b");
		const iterator = streamRepo(root, { maxFiles: 1 });
		expect((await iterator.next()).done).toBe(false);
		await expect(iterator.next()).rejects.toMatchObject({
			reason: "repository indexing limit exceeded",
		});
		await expect(
			streamRepo(root, { maxFiles: 0 }).next(),
		).rejects.toMatchObject({ reason: "invalid walk limit" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
