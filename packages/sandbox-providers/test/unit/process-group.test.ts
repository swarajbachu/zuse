import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import type { SandboxProcessInput } from "../../src/index.ts";
import {
	processGroupCommand,
	processGroupInspectionCommand,
} from "../../src/process-group.ts";

const execute = promisify(execFile);
const fixture = async (
	run: (f: {
		launch: (
			activation?: SandboxProcessInput["activation"],
			failStop?: boolean,
		) => Promise<unknown>;
		inspect: () => Promise<string>;
		starts: () => Promise<number>;
		directory: string;
	}) => Promise<void>,
) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-process-group-"));
	const journal = join(directory, "journal");
	await mkdir(journal);
	await writeFile(
		join(directory, "sudo"),
		'#!/bin/bash\nwhile [[ "$1" == -* ]]; do if [ "$1" = -u ]; then shift; fi; shift; done\nexec "$@"\n',
		{ mode: 0o700 },
	);
	await writeFile(
		join(directory, "install"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell array expansion
		'#!/bin/bash\na=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift ;; *) a+=("$1") ;; esac; shift; done\nexec /usr/bin/install "${a[@]}"\n',
		{ mode: 0o700 },
	);
	const command = (value: string, failStop = false) => {
		const encoded = value.match(/printf %s ([A-Za-z0-9+/=]+)/)?.[1];
		if (!encoded) throw new Error("missing script");
		let script = Buffer.from(encoded, "base64")
			.toString()
			.replaceAll("/var/lib/zuse-process-activations", journal);
		if (failStop)
			script = script.replace('kill -TERM -- "-$process_pid"', "exit 71");
		return value.replace(encoded, Buffer.from(script).toString("base64"));
	};
	const options = {
		env: {
			...process.env,
			HOME: directory,
			PATH: `${directory}:${process.env.PATH}`,
		},
		timeout: 15_000,
	};
	const selector = { tag: "runtime" };
	try {
		await run({
			directory,
			launch: (activation, failStop) =>
				execute(
					"bash",
					[
						"-c",
						command(
							processGroupCommand(
								{
									command: "/bin/bash",
									args: [
										"-c",
										`exec 7>'${directory}/writer'; flock -n 7 || { echo overlap >>'${directory}/overlap'; exit 1; }; echo start >>'${directory}/starts'; setsid sleep 30 >/dev/null 2>&1 & echo $! >'${directory}/escaped'; exec sleep 30`,
									],
									user: "user",
									activation,
								},
								selector,
							),
							failStop,
						),
					],
					options,
				),
			inspect: async () =>
				(
					await execute(
						"bash",
						["-c", command(processGroupInspectionCommand(selector, "user"))],
						options,
					)
				).stdout,
			starts: async () => {
				for (let attempt = 0; attempt < 100; attempt++) {
					try {
						return (await readFile(join(directory, "starts"), "utf8"))
							.trim()
							.split("\n").length;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				}
				throw new Error("runtime did not start");
			},
		});
	} finally {
		for (const unit of await readdir(journal)) {
			try {
				const pid = Number(
					(await readFile(join(journal, unit, "process"), "utf8")).split(
						" ",
					)[1],
				);
				process.kill(-pid, "SIGTERM");
				await new Promise((resolve) => setTimeout(resolve, 150));
			} catch {}
		}
		// An abrupt-supervisor test deliberately leaves this fixture-only child.
		try {
			process.kill(
				Number(await readFile(join(directory, "escaped"), "utf8")),
				"SIGKILL",
			);
		} catch {}
		await rm(directory, { recursive: true, force: true });
	}
};
describe("envd guest process ownership", () => {
	test("same-operation response-loss retry launches once and fences stale commands", async () =>
		fixture(async (f) => {
			await f.launch({ generation: 2, operationId: "new" });
			expect(await f.starts()).toBe(1);
			await f.launch({ generation: 2, operationId: "new" });
			await expect(
				f.launch({ generation: 1, operationId: "old" }),
			).rejects.toBeDefined();
			await expect(
				f.launch({ generation: 2, operationId: "conflict" }),
			).rejects.toBeDefined();
			await expect(f.launch()).rejects.toBeDefined();
			expect(await f.inspect()).toBe("active");
			expect(await f.starts()).toBe(1);
		}));
	test("concurrent same-operation launches share one writer", async () =>
		fixture(async (f) => {
			await Promise.all([
				f.launch({ generation: 1, operationId: "same" }),
				f.launch({ generation: 1, operationId: "same" }),
			]);
			expect(await f.starts()).toBe(1);
			await expect(
				readFile(join(f.directory, "overlap")),
			).rejects.toBeDefined();
		}));
	test("failed stop cannot launch and persisted intent resumes safely", async () =>
		fixture(async (f) => {
			await f.launch({ generation: 1, operationId: "first" });
			expect(await f.starts()).toBe(1);
			await expect(
				f.launch({ generation: 2, operationId: "second" }, true),
			).rejects.toMatchObject({ code: 71 });
			expect(await f.starts()).toBe(1);
			const oldChild = Number(
				await readFile(join(f.directory, "escaped"), "utf8"),
			);
			await f.launch({ generation: 2, operationId: "second" });
			expect(() => process.kill(oldChild, 0)).toThrow();
			for (let attempt = 0; attempt < 100 && (await f.starts()) < 2; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(await f.starts()).toBe(2);
			await expect(
				readFile(join(f.directory, "overlap")),
			).rejects.toBeDefined();
		}));
	test("abrupt supervisor death leaves escaped children fenced as unknown", async () =>
		fixture(async (f) => {
			await f.launch({ generation: 1, operationId: "abrupt" });
			expect(await f.starts()).toBe(1);
			const [unit] = await readdir(join(f.directory, "journal"));
			if (unit === undefined) throw new Error("missing process journal");
			const journal = join(f.directory, "journal", unit);
			const identity = (
				await readFile(join(journal, "process"), "utf8")
			).trim();
			const pid = Number(identity.split(" ")[1]);
			const escaped = Number(
				await readFile(join(f.directory, "escaped"), "utf8"),
			);
			process.kill(-pid, "SIGKILL");
			await vi.waitFor(async () => expect(await f.inspect()).toBe("unknown"));
			expect(() => process.kill(escaped, 0)).not.toThrow();
			await expect(
				f.launch({ generation: 2, operationId: "replacement" }),
			).rejects.toBeDefined();
			expect(await f.starts()).toBe(1);
			// A stale receipt from another operation cannot establish retirement.
			await writeFile(
				join(journal, "retired"),
				`${identity.replace("abrupt", "other")}\n`,
			);
			expect(await f.inspect()).toBe("unknown");
		}));
});
