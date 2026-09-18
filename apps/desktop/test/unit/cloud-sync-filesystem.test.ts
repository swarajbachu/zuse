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
import { setTimeout as settleIO } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { CloudSyncManager } from "../../src/sync/cloud-sync-service.ts";

// Execute the real remote rsync/tar commands locally, without credentials or a sandbox.
// This exercises both production transports and the shared live-directory apply.
// Real subprocesses and 1,000 watched file writes need headroom on shared CI
// runners; the per-operation waits below still enforce their 30-second limits.
test.each([
	false,
	true,
])("staged filesystem sync is incremental (legacy=%s)", async (legacy) => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const root = await mkdtemp(join(tmpdir(), "zuse-sync-fs-"));
	const source = join(root, "source");
	const target = join(root, "target");
	const bin = join(root, "bin");
	await Promise.all([mkdir(source), mkdir(bin)]);
	await writeFile(
		join(bin, "ssh"),
		`#!/bin/sh\nshift 3\n${legacy ? 'if [ "$1" = "rsync" ]; then echo "rsync: command not found" >&2; exit 127; fi\n' : ""}exec "$@"\n`,
	);
	await chmod(join(bin, "ssh"), 0o755);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	const manager = new CloudSyncManager(() => {});
	let watcher: ReturnType<typeof watch> | undefined;
	const settle = async () => {
		const deadline = performance.now() + 30_000;
		while (
			manager.status("files").state === "syncing" &&
			performance.now() < deadline
		)
			await settleIO(10);
		expect(manager.status("files").error).toBeNull();
		expect(manager.status("files").state).toBe("in-sync");
	};
	const batch = async () => {
		manager.requestSync("files");
		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
	};
	try {
		for (const prefix of ["", "apps/web/"]) {
			await mkdir(join(source, prefix, ".next/cache"), { recursive: true });
			await writeFile(join(source, prefix, ".next/cache/pack"), "cache");
			await writeFile(join(source, prefix, ".next/config.json"), "{}");
		}
		await writeFile(join(source, "app.js"), "export default 1;\n");
		await writeFile(join(source, "old.js"), "old");
		await writeFile(join(source, ".gitignore"), "private/\n");
		await symlink("app.js", join(source, "link.js"));
		await manager.configure({
			workspaceId: "files",
			enabled: true,
			localPath: target,
			hostAlias: "zuse-files",
			remotePath: source,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		for (const prefix of ["", "apps/web/"]) {
			expect(await readdir(join(target, prefix, ".next"))).toEqual([
				"config.json",
			]);
		}
		await Promise.all([
			mkdir(join(target, "node_modules")),
			mkdir(join(target, ".git")),
			mkdir(join(target, "private")),
		]);
		await writeFile(join(target, "node_modules", "keep"), "dependency");
		await writeFile(join(target, ".git", "keep"), "git");
		await writeFile(join(target, "private", "keep"), "ignored");
		const before = await stat(join(target, "app.js"));
		const events: string[] = [];
		watcher = watch(target, { recursive: true }, (_event, filename) => {
			if (filename !== null) events.push(filename.toString());
		});
		await batch();
		await settleIO(50);
		expect(events).toEqual([]);
		expect((await stat(join(target, "app.js"))).mtimeMs).toBe(before.mtimeMs);
		expect((await stat(join(target, "app.js"))).ino).toBe(before.ino);
		expect(await readFile(join(target, "private", "keep"), "utf8")).toBe(
			"ignored",
		);
		// A large change is staged and applied together; the latest bytes win even at identical size/mtime.
		await writeFile(join(source, "app.js"), "export default 2;\n");
		await rm(join(source, "old.js"));
		await Promise.all(
			Array.from({ length: 1_000 }, (_, index) =>
				writeFile(
					join(source, `module-${index}.js`),
					`export default ${index};\n`,
				),
			),
		);
		await batch();
		expect(await readFile(join(target, "app.js"), "utf8")).toBe(
			"export default 2;\n",
		);
		expect(await readdir(target)).not.toContain("old.js");
		expect(await readFile(join(target, "module-999.js"), "utf8")).toBe(
			"export default 999;\n",
		);
		expect(await readFile(join(target, "node_modules", "keep"), "utf8")).toBe(
			"dependency",
		);
		expect(await readFile(join(target, ".git", "keep"), "utf8")).toBe("git");
		expect(await readlink(join(target, "link.js"))).toBe("app.js");
		// A failed download cannot remove or replace live files.
		await writeFile(
			join(bin, "ssh"),
			"#!/bin/sh\necho 'connection closed' >&2\nexit 12\n",
		);
		manager.requestSync("files");
		await vi.advanceTimersByTimeAsync(15_000);
		const deadline = performance.now() + 30_000;
		while (
			manager.status("files").state === "syncing" &&
			performance.now() < deadline
		)
			await settleIO(10);
		expect(manager.status("files").state).toBe("error");
		expect(await readFile(join(target, "app.js"), "utf8")).toBe(
			"export default 2;\n",
		);
	} finally {
		watcher?.close();
		await manager.dispose();
		expect(
			(await readdir(root)).filter((name) => name.includes("incoming-")),
		).toEqual([]);
		await rm(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
		vi.useRealTimers();
	}
}, 60_000);
