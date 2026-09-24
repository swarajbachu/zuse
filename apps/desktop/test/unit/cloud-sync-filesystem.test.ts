import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import {
	applySnapshot,
	downloadSnapshot,
	localBaseline,
	readSyncManifest,
	writeSyncManifest,
} from "../../src/sync/cloud-sync-snapshot.ts";

const exec = promisify(execFile);

test("Gateway archive Git-selected snapshots preserve tracked builds, ignore arbitrary outputs, and publish only changed bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-snapshot-"));
	const source = join(root, "source");
	const target = join(root, "target");
	const bin = join(root, "bin");
	await Promise.all([mkdir(source), mkdir(target), mkdir(bin)]);
	// Execute the production SSH protocol locally. No rsync, tar, network, or credentials.
	await writeFile(
		join(bin, "ssh"),
		'#!/bin/sh\nfor arg do command="$arg"; done\nexec sh -c "$command"\n',
	);
	await chmod(join(bin, "ssh"), 0o755);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	let watcher: ReturnType<typeof watch> | undefined;
	const controller = new AbortController();
	let failGateway = false;
	let reading = 0,
		maxReading = 0;
	const scan = async () => {
		const staging = await mkdtemp(join(root, "stage-"));
		try {
			const previous = await readSyncManifest(target, "files");
			const baseline = await localBaseline(target, previous.files);
			const progress = vi.fn();
			const files = await downloadSnapshot(
				{
					hostAlias: "test",
					remotePath: source,
					readRemoteFile: async (path) => {
						if (failGateway) throw new Error("gateway lost");
						reading++;
						maxReading = Math.max(maxReading, reading);
						try {
							return new Uint8Array(await readFile(path));
						} finally {
							reading--;
						}
					},
				},
				staging,
				baseline,
				controller.signal,
				progress,
			);
			expect(progress).toHaveBeenLastCalledWith(
				expect.objectContaining({ files: files.length, total: files.length }),
			);
			await applySnapshot(target, staging, previous, files, controller.signal);
			return files;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	};
	try {
		await exec("git", ["init", "-q", source]);
		await mkdir(join(source, "dist"));
		await mkdir(join(source, "custom-output"));
		await mkdir(join(source, "nested"));
		await writeFile(join(source, "dist/tracked.js"), "tracked build");
		await exec("git", ["-C", source, "add", "dist/tracked.js"]);
		await writeFile(
			join(source, ".gitignore"),
			"dist/\ncustom-output/\n.context/\n*.generated\n!keep.generated\n",
		);
		await writeFile(join(source, "nested/.gitignore"), "cache/\n");
		await mkdir(join(source, "nested/cache"));
		await writeFile(join(source, "nested/cache/noise"), "ignored");
		await writeFile(join(source, "dist/ignored.js"), "ignored build");
		await writeFile(join(source, "custom-output/noise"), "ignored");
		await writeFile(join(source, "keep.generated"), "explicitly included");
		await writeFile(join(source, "app.js"), "version 1");
		await writeFile(join(source, "spaces and\nnewlines.js"), "valid path");
		await symlink("app.js", join(source, "link.js"));
		await writeSyncManifest(target, {
			version: 1,
			workspaceId: "files",
			files: [],
		});
		await writeFile(join(source, "large.bin"), randomBytes(9 * 1024 * 1024));
		const files = await scan();
		expect(maxReading).toBe(2);
		expect(files.map((f) => f.path)).toContain("dist/tracked.js");
		expect(files.map((f) => f.path)).toContain("keep.generated");
		expect(files.map((f) => f.path)).not.toContain("nested/cache/noise");
		expect(await readdir(join(target, "dist"))).toEqual(["tracked.js"]);
		expect(await readlink(join(target, "link.js"))).toBe("app.js");
		await mkdir(join(target, "custom-output"));
		await writeFile(join(target, "custom-output/local"), "keep local");
		const events: string[] = [];
		watcher = watch(target, (_event, file) => {
			if (file !== null) events.push(file.toString());
		});
		const before = await stat(join(target, "app.js"));
		await writeFile(join(source, "custom-output/noise"), "continuous build");
		await scan();
		expect(events).toEqual([]);
		expect((await stat(join(target, "app.js"))).mtimeMs).toBe(before.mtimeMs);
		await writeFile(join(source, "app.js"), "version 2");
		await rm(join(source, "dist/tracked.js"));
		await scan();
		expect(await readFile(join(target, "app.js"), "utf8")).toBe("version 2");
		expect(await readFile(join(target, "custom-output/local"), "utf8")).toBe(
			"keep local",
		);
		expect(
			(await readSyncManifest(target, "files")).files.map((f) => f.path),
		).not.toContain("dist/tracked.js");
		// Local modifications must be repaired even when remote hashes are unchanged.
		await writeFile(join(target, "app.js"), "local edit");
		await scan();
		expect(await readFile(join(target, "app.js"), "utf8")).toBe("version 2");
		// A large change publishes full files, never transfer scratch files.
		events.length = 0;
		await Promise.all(
			Array.from({ length: 1000 }, (_, i) =>
				writeFile(join(source, `module-${i}.js`), `export default ${i};`),
			),
		);
		await scan();
		expect(await readFile(join(target, "module-999.js"), "utf8")).toBe(
			"export default 999;",
		);
		expect(
			events.some(
				(path) => path.includes(".partial") || path.includes("objects"),
			),
		).toBe(false);
		// File/directory replacements only remove owned paths.
		await writeFile(join(source, "shape"), "file");
		await scan();
		await rm(join(source, "shape"));
		await mkdir(join(source, "shape"));
		await writeFile(join(source, "shape/child"), "nested");
		await scan();
		expect(await readFile(join(target, "shape/child"), "utf8")).toBe("nested");
		await rm(join(source, "shape"), { recursive: true });
		await writeFile(join(source, "shape"), "file again");
		await scan();
		expect(await readFile(join(target, "shape"), "utf8")).toBe("file again");
		// Replay a process interrupted after publication but before manifest commit.
		const committed = await readSyncManifest(target, "files");
		await writeFile(
			join(target, "interrupted"),
			"orphan from incomplete batch",
		);
		await writeSyncManifest(target, {
			...committed,
			pending: [
				...committed.files,
				{ path: "interrupted", hash: "a".repeat(64), mode: 420, size: 28 },
			],
		});
		await scan();
		expect(await readdir(target)).not.toContain("interrupted");
		expect((await readSyncManifest(target, "files")).pending).toBeUndefined();
		// A local symlink must never redirect a managed write outside the mirror.
		const outside = join(root, "outside");
		await mkdir(outside);
		await rm(join(target, "nested"), { recursive: true });
		await symlink(outside, join(target, "nested"));
		await expect(scan()).rejects.toThrow("ancestor");
		expect(await readdir(outside)).toEqual([]);
		await rm(join(target, "nested"));
		await scan();
		failGateway = true;
		await expect(scan()).rejects.toThrow("gateway lost");
		failGateway = false;
		// Stream failure cannot publish partial content or delete the last good state.
		await writeFile(
			join(bin, "ssh"),
			'#!/bin/sh\nprintf "{\\"done\\":true}\\n"\nexit 1\n',
		);
		await expect(scan()).rejects.toThrow();
		expect(await readFile(join(target, "app.js"), "utf8")).toBe("version 2");
	} finally {
		watcher?.close();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("interrupted transfers retain verified objects and retries reuse them", async () => {
	const { createHash } = await import("node:crypto");
	const { cachedBaseline } = await import(
		"../../src/sync/cloud-sync-snapshot.ts"
	);
	const root = await mkdtemp(join(tmpdir(), "zuse-resume-"));
	const bin = join(root, "bin");
	const cache = join(root, "cache");
	await Promise.all([mkdir(bin), mkdir(cache)]);
	const bytes = Buffer.from("a completed file before the connection drops");
	const file = {
		path: "src/file.txt",
		hash: createHash("sha256").update(bytes).digest("hex"),
		mode: 420,
		size: bytes.length,
	};
	const installStream = async (stream: Buffer, code: number) => {
		await writeFile(
			join(bin, "ssh"),
			`#!/bin/sh\npython3 -c 'import sys;sys.stdout.buffer.write(bytes.fromhex("${stream.toString("hex")}"))'\nexit ${code}\n`,
		);
		await chmod(join(bin, "ssh"), 0o755);
	};
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	try {
		await installStream(
			Buffer.concat([
				Buffer.from(`${JSON.stringify({ ...file, content: true })}\n`),
				bytes,
			]),
			1,
		);
		await expect(
			downloadSnapshot(
				{ hostAlias: "test", remotePath: "/repo" },
				cache,
				[],
				new AbortController().signal,
			),
		).rejects.toThrow();
		const baseline = await cachedBaseline(cache);
		expect(baseline).toEqual([file]);
		const before = await stat(join(cache, "objects", file.hash));
		await installStream(
			Buffer.from(
				`${JSON.stringify({ ...file, content: false })}\n{"done":true}\n`,
			),
			0,
		);
		expect(
			await downloadSnapshot(
				{ hostAlias: "test", remotePath: "/repo" },
				cache,
				baseline,
				new AbortController().signal,
			),
		).toEqual([file]);
		expect((await stat(join(cache, "objects", file.hash))).mtimeMs).toBe(
			before.mtimeMs,
		);
		// A corrupt cached object is never offered as a valid baseline.
		await writeFile(join(cache, "objects", file.hash), "corrupt");
		expect(await cachedBaseline(cache)).toEqual([]);
	} finally {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});

test("malformed paths and corrupt payloads cannot become verified objects", async () => {
	const { createHash } = await import("node:crypto");
	const { cachedBaseline } = await import(
		"../../src/sync/cloud-sync-snapshot.ts"
	);
	const root = await mkdtemp(join(tmpdir(), "zuse-reject-"));
	const bin = join(root, "bin");
	const cache = join(root, "cache");
	await Promise.all([mkdir(bin), mkdir(cache)]);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	try {
		for (const path of [
			"../escape",
			"nested/../../escape",
			".git/config",
			"file.txt",
		]) {
			const entry = {
				path,
				hash: createHash("sha256").update("correct").digest("hex"),
				mode: 420,
				size: 5,
				content: true,
			};
			const stream = Buffer.from(
				`${JSON.stringify(entry)}\nwrong{"done":true}\n`,
			);
			await writeFile(
				join(bin, "ssh"),
				`#!/bin/sh\npython3 -c 'import sys;sys.stdout.buffer.write(bytes.fromhex("${stream.toString("hex")}"))'\n`,
			);
			await chmod(join(bin, "ssh"), 0o755);
			await expect(
				downloadSnapshot(
					{ hostAlias: "test", remotePath: "/repo" },
					cache,
					[],
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(await cachedBaseline(cache)).toEqual([]);
		}
		expect(await readdir(root)).toEqual(
			expect.arrayContaining(["cache", "bin"]),
		);
		expect(await readdir(root)).not.toContain("escape");
	} finally {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});
