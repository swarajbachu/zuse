import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
	boxForkRuntimeResetCommand,
	boxProcessCleanupScript,
	boxProcessUnit,
	boxSystemdProcessCommand,
} from "../../src/box-process.ts";
import type { SandboxProcessInput } from "../../src/index.ts";

// Run the real generated launcher without requiring root or touching /var/lib.
// Ownership flags alone are omitted; locking, journal persistence and process
// manager ordering are exercised unchanged.
const sandboxedCommand = (command: string, directory: string): string => {
	const encoded = command.match(/printf %s ([A-Za-z0-9+/=]+)/)?.[1];
	if (encoded === undefined) throw new Error("Missing launcher script");
	const script = Buffer.from(encoded, "base64")
		.toString("utf8")
		// Other fixture guests share this host's /proc during parallel tests.
		.replaceAll(
			"const info=fs.readFileSync",
			`if(!path.startsWith("${directory}/"))continue;const info=fs.readFileSync`,
		)
		.replaceAll("/var/lib/zuse-process-activations", join(directory, "journal"))
		.replaceAll("/var/lib/zuse-fork-preparation", join(directory, "forkprep"))
		.replaceAll("/var/lib/zuse/runtime-update", join(directory, "updater"))
		.replaceAll("/proc", join(directory, "proc"))
		.replaceAll("-o root -g root", "");
	return command.replace(encoded, Buffer.from(script).toString("base64"));
};

const withActivationLauncher = async (
	run: (launcher: {
		launch: (
			activation?: SandboxProcessInput["activation"],
			faults?: Record<string, string>,
		) => Promise<unknown>;
		state: () => Promise<{
			active: string;
			description: string;
			starts: number;
			stops: number;
		}>;
		owner: () => Promise<string>;
		resetFork: (
			childId: string,
			faults?: Record<string, string>,
		) => Promise<unknown>;
		directory: string;
	}) => Promise<void>,
) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-activation-"));
	try {
		await mkdir(join(directory, "proc"));
		const stateFile = join(directory, "state.json");
		await writeFile(
			stateFile,
			JSON.stringify({
				active: "inactive",
				description: "",
				starts: 0,
				stops: 0,
			}),
		);
		const stub = async (name: string, script: string) =>
			writeFile(join(directory, name), `#!${process.execPath}\n${script}`, {
				mode: 0o700,
			});
		await stub(
			"sudo",
			`const {spawnSync}=require('node:child_process');let a=process.argv.slice(2);while(a[0]?.startsWith('-')){const v=a.shift();if(v==='-u')a.shift();}const r=spawnSync(a[0],a.slice(1),{stdio:'inherit',env:process.env});process.exit(r.status??1);`,
		);
		await stub(
			"getent",
			`console.log('zuse:x:1000:1000::'+${JSON.stringify(directory)}+':/bin/bash');`,
		);
		const readState = `const fs=require('node:fs');const file=${JSON.stringify(stateFile)};const state=JSON.parse(fs.readFileSync(file,'utf8'));const save=()=>fs.writeFileSync(file,JSON.stringify(state));`;
		await stub(
			"systemctl",
			`${readState}
const args=process.argv.slice(2);
if(args[0]==='show') {
  const property=args.find(value=>value.startsWith('--property='));
  if(property==='--property=LoadState') console.log(state.description ? 'loaded' : 'not-found');
  else if(property==='--property=Description') console.log(state.description);
  else if(property==='--property=ActiveState') console.log(state.active);
  else process.exit(2);
} else if(args[0]==='list-units') {
  if(state.description) console.log(${JSON.stringify(boxProcessUnit("zuse", "runtime"))}+' loaded active running');
} else if(args[0]==='stop') {
  state.stops++;save();
  if(process.env.STOP_FAIL==='1') process.exit(1);
  if(process.env.STOP_STAYS_ACTIVE!=='1') { state.active='inactive';save(); }
} else process.exit(2);`,
		);
		await stub(
			"systemd-run",
			`${readState}
if(state.active==='active') process.exit(99);
if(process.env.START_FAIL==='1') process.exit(1);
state.starts++;
state.active='active';
state.description=process.argv.find(value=>value.startsWith('--description=')).slice(14);
save();
setTimeout(()=>process.exit(process.env.RESPONSE_LOST==='1'?1:0),50);`,
		);
		const unit = boxProcessUnit("zuse", "runtime");
		await run({
			directory,
			resetFork: (childId, faults = {}) =>
				promisify(execFile)(
					"bash",
					[
						"-c",
						sandboxedCommand(
							boxForkRuntimeResetCommand(childId, "zuse", { tag: "runtime" }),
							directory,
						),
					],
					{
						timeout: 10_000,
						env: {
							...process.env,
							...faults,
							PATH: `${directory}:${process.env.PATH}`,
						},
					},
				),
			launch: (activation, faults = {}) =>
				promisify(execFile)(
					"bash",
					[
						"-c",
						sandboxedCommand(
							boxSystemdProcessCommand(
								{ command: "true", user: "zuse", activation },
								unit,
								{ tag: "runtime" },
							),
							directory,
						),
					],
					{
						timeout: 10_000,
						env: {
							...process.env,
							...faults,
							PATH: `${directory}:${process.env.PATH}`,
						},
					},
				),
			state: async () => JSON.parse(await readFile(stateFile, "utf8")),
			owner: () => readFile(join(directory, "journal", unit, "owner"), "utf8"),
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

describe("Box fenced process activation", () => {
	test("rejects delayed older, conflicting and legacy replacements before stopping the current owner", async () => {
		await withActivationLauncher(async ({ launch, state, owner }) => {
			await launch({ operationId: "owner-2", generation: 2 });
			for (const stale of [
				{ operationId: "owner-1", generation: 1 },
				{ operationId: "other-owner", generation: 2 },
				undefined,
			]) {
				await expect(launch(stale)).rejects.toMatchObject({ code: 1 });
			}
			expect(await state()).toMatchObject({
				starts: 1,
				stops: 0,
				active: "active",
			});
			expect(await owner()).toBe("2 owner-2\n");
		});
	});
	test("serializes concurrent duplicate launches and performs one replacement for the next owner", async () => {
		await withActivationLauncher(async ({ launch, state }) => {
			await Promise.all(
				Array.from({ length: 3 }, () =>
					launch({ operationId: "owner-1", generation: 1 }),
				),
			);
			expect(await state()).toMatchObject({ starts: 1, stops: 0 });
			await Promise.all(
				Array.from({ length: 3 }, () =>
					launch({ operationId: "owner-2", generation: 2 }),
				),
			);
			expect(await state()).toMatchObject({
				starts: 2,
				stops: 1,
				description: "Zuse-managed-process:2:owner-2",
			});
		});
	});
	test.each([
		"STOP_FAIL",
		"STOP_STAYS_ACTIVE",
	])("cannot launch a second writer when %s", async (fault) => {
		await withActivationLauncher(async ({ launch, state, owner }) => {
			await launch({ operationId: "owner-1", generation: 1 });
			await expect(
				launch({ operationId: "owner-2", generation: 2 }, { [fault]: "1" }),
			).rejects.toMatchObject({ code: 1 });
			expect(await state()).toMatchObject({
				starts: 1,
				stops: 1,
				active: "active",
			});
			expect(await owner()).toBe("2 owner-2\n");
			await expect(
				launch({ operationId: "owner-1", generation: 1 }),
			).rejects.toMatchObject({ code: 1 });
			await launch({ operationId: "owner-2", generation: 2 });
			expect(await state()).toMatchObject({ starts: 2, stops: 2 });
		});
	});
	test("retries a persisted intent after launch failure without reviving an older owner", async () => {
		await withActivationLauncher(async ({ launch, state, owner }) => {
			await launch({ operationId: "owner-1", generation: 1 });
			await expect(
				launch({ operationId: "owner-2", generation: 2 }, { START_FAIL: "1" }),
			).rejects.toMatchObject({ code: 1 });
			expect(await state()).toMatchObject({ starts: 1, active: "inactive" });
			expect(await owner()).toBe("2 owner-2\n");
			await launch({ operationId: "owner-2", generation: 2 });
			expect(await state()).toMatchObject({ starts: 2, active: "active" });
		});
	});
	test("retries a first launch whose intent survived before a unit existed", async () => {
		await withActivationLauncher(async ({ launch, state }) => {
			await expect(
				launch({ operationId: "owner-1", generation: 1 }, { START_FAIL: "1" }),
			).rejects.toMatchObject({ code: 1 });
			await launch({ operationId: "owner-1", generation: 1 });
			expect(await state()).toMatchObject({ starts: 1, stops: 0 });
		});
	});
	test("lost provider response returns the existing matching active owner without stopping it", async () => {
		await withActivationLauncher(async ({ launch, state }) => {
			await expect(
				launch(
					{ operationId: "owner-1", generation: 1 },
					{ RESPONSE_LOST: "1" },
				),
			).rejects.toMatchObject({ code: 1 });
			await launch({ operationId: "owner-1", generation: 1 });
			expect(await state()).toMatchObject({
				starts: 1,
				stops: 0,
				active: "active",
			});
		});
	});
	test.each([
		{ operationId: "owner", generation: 0 },
		{ operationId: "owner", generation: 1.5 },
		{ operationId: "owner", generation: Number.MAX_SAFE_INTEGER + 1 },
		{ operationId: "bad\noperation", generation: 1 },
	])("rejects invalid ownership before generating a command: %s", (activation) => {
		expect(() =>
			boxSystemdProcessCommand(
				{ command: "true", activation },
				boxProcessUnit("zuse", "runtime"),
			),
		).toThrow("Invalid managed process activation");
	});
});

describe("Box quarantined fork ownership reset", () => {
	test("an active updater keeps its copied transaction and ownership until its lock is released", async () => {
		await withActivationLauncher(
			async ({ launch, resetFork, owner, directory }) => {
				await mkdir(join(directory, "updater"));
				const transaction = join(directory, "updater", "transaction.json");
				await writeFile(transaction, "parent transaction");
				await launch({ operationId: "parent", generation: 9 });
				const holder = execFile("flock", [
					"-x",
					`${transaction}.lock`,
					"bash",
					"-c",
					"printf ready; read -r release",
				]);
				const exited = new Promise<void>((resolve) =>
					holder.once("exit", () => resolve()),
				);
				try {
					await new Promise<void>((resolve, reject) => {
						holder.stdout?.once("data", () => resolve());
						holder.once("error", reject);
					});
					await expect(resetFork("child")).rejects.toMatchObject({ code: 1 });
					expect(await owner()).toBe("9 parent\n");
					expect(await readFile(transaction, "utf8")).toBe(
						"parent transaction",
					);
				} finally {
					holder.stdin?.end("\n");
					await exited;
				}
				await resetFork("child");
				await expect(owner()).rejects.toMatchObject({ code: "ENOENT" });
			},
		);
	});
	test("resets only copied ownership once per child, preserving data and a subsequently launched child owner", async () => {
		await withActivationLauncher(
			async ({ launch, resetFork, state, owner, directory }) => {
				await mkdir(join(directory, "updater"));
				await writeFile(
					join(directory, "updater", "transaction.json"),
					"parent transaction",
				);
				await writeFile(join(directory, "zuse.sqlite"), "original database");
				await writeFile(
					join(directory, "signed-release.tar.gz"),
					"signed archive",
				);
				const otherJournal = join(
					directory,
					"journal",
					boxProcessUnit("zuse", "other"),
				);
				await mkdir(otherJournal, { recursive: true });
				await writeFile(join(otherJournal, "owner"), "9 other\n");
				await launch({ operationId: "parent", generation: 9 });
				await resetFork("child-a");
				expect(await state()).toMatchObject({
					starts: 1,
					stops: 1,
					active: "inactive",
				});
				await expect(owner()).rejects.toMatchObject({ code: "ENOENT" });
				await expect(
					readFile(join(directory, "updater", "transaction.json")),
				).rejects.toMatchObject({ code: "ENOENT" });
				expect(await readFile(join(directory, "zuse.sqlite"), "utf8")).toBe(
					"original database",
				);
				expect(
					await readFile(join(directory, "signed-release.tar.gz"), "utf8"),
				).toBe("signed archive");
				expect(await readFile(join(otherJournal, "owner"), "utf8")).toBe(
					"9 other\n",
				);
				await launch({ operationId: "child", generation: 1 });
				const childState = await state();
				await resetFork("child-a");
				expect(await state()).toEqual(childState);
				expect(await owner()).toBe("1 child\n");
				// A copied marker for a previous child cannot suppress grandchild reset.
				await resetFork("child-b");
				expect(await state()).toMatchObject({
					stops: childState.stops + 1,
					active: "inactive",
				});
			},
		);
	});
	test("a failed retirement preserves copied journals and remains retryable", async () => {
		await withActivationLauncher(
			async ({ launch, resetFork, owner, directory }) => {
				await mkdir(join(directory, "updater"));
				await writeFile(
					join(directory, "updater", "transaction.json"),
					"parent transaction",
				);
				await launch({ operationId: "parent", generation: 9 });
				await expect(
					resetFork("child", { STOP_FAIL: "1" }),
				).rejects.toMatchObject({ code: 1 });
				expect(await owner()).toBe("9 parent\n");
				expect(
					await readFile(
						join(directory, "updater", "transaction.json"),
						"utf8",
					),
				).toBe("parent transaction");
				await resetFork("child");
				await expect(owner()).rejects.toMatchObject({ code: "ENOENT" });
			},
		);
	});
	test("an unaccounted SQLite writer blocks reset after process retirement", async () => {
		await withActivationLauncher(
			async ({ launch, resetFork, owner, directory }) => {
				const processPath = join(directory, "proc", "123");
				await mkdir(join(processPath, "fd"), { recursive: true });
				await mkdir(join(processPath, "fdinfo"));
				await symlink(
					join(directory, "zuse.sqlite-wal"),
					join(processPath, "fd", "7"),
				);
				await writeFile(join(processPath, "fdinfo", "7"), "flags:\t0100002\n");
				await launch({ operationId: "parent", generation: 9 });
				await expect(resetFork("child")).rejects.toMatchObject({ code: 1 });
				expect(await owner()).toBe("9 parent\n");
				await rm(join(processPath, "fd", "7"));
				await resetFork("child");
				await expect(owner()).rejects.toMatchObject({ code: "ENOENT" });
			},
		);
	});
});

describe("Box systemd process launcher", () => {
	test("cleanup for one punctuation tag leaves the other PID record intact", async () => {
		const home = await mkdtemp(join(tmpdir(), "zuse-tags-"));
		try {
			const directory = join(home, ".zuse-processes");
			await mkdir(directory);
			for (const name of ["612f62.pid", "613f62.pid", "612d62.pid"])
				await writeFile(join(directory, name), "old-boot 42\n");
			expect((await readdir(directory)).sort()).toEqual([
				"612d62.pid",
				"612f62.pid",
				"613f62.pid",
			]);
			const other = await readFile(join(directory, "613f62.pid"), "utf8");
			// Seed pre-upgrade records explicitly; new launches use provider ownership.
			await promisify(execFile)(
				"bash",
				[
					"-c",
					`kill() { return 0; }; ${boxProcessCleanupScript({ tag: "a/b" })}`,
				],
				{ env: { ...process.env, HOME: home } },
			);
			expect((await readdir(directory)).sort()).toEqual([
				"612d62.pid",
				"613f62.pid",
			]);
			expect(await readFile(join(directory, "613f62.pid"), "utf8")).toBe(other);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test("does not alias users or punctuation in process tags", () => {
		expect(
			new Set([
				boxProcessUnit("zuse", "a/b"),
				boxProcessUnit("zuse", "a-b"),
				boxProcessUnit("root", "a/b"),
			]).size,
		).toBe(3);
	});

	test.each([
		false,
		true,
	])("preserves account environment and stops on service-stop failure=%s", async (stopFails) => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-systemd-test-"));
		try {
			const targetHome = join(directory, "home with spaces");
			const capture = join(directory, "captured.json");
			// Managed services must not depend on writable legacy PID storage.
			await mkdir(targetHome);
			await writeFile(
				join(targetHome, ".zuse-processes"),
				"unwritable legacy path",
			);
			const stub = async (name: string, script: string) =>
				writeFile(join(directory, name), `#!${process.execPath}\n${script}`, {
					mode: 0o700,
				});
			await stub(
				"sudo",
				`const {spawnSync}=require('node:child_process');let a=process.argv.slice(2);while(a[0]?.startsWith('-')){const v=a.shift();if(v==='-u')a.shift();}const r=spawnSync(a[0],a.slice(1),{stdio:'inherit',env:process.env});process.exit(r.status??1);`,
			);
			await stub(
				"getent",
				`console.log('zuse:x:1000:1000::'+${JSON.stringify(targetHome)}+':/bin/bash');`,
			);
			await stub(
				"systemctl",
				`if(process.argv[2]==='show')console.log('loaded');else if(process.argv[2]==='stop')process.exit(${stopFails ? 1 : 0});else process.exit(2);`,
			);
			await stub(
				"systemd-run",
				`const {writeFileSync}=require('node:fs');const {spawnSync}=require('node:child_process');const a=process.argv.slice(2),end=a.indexOf('--'),env={};for(const v of a.slice(0,end)){if(v.startsWith('--setenv=')){const s=v.slice(9),i=s.indexOf('=');env[s.slice(0,i)]=s.slice(i+1);}}writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:a.slice(0,end),env}));const r=spawnSync(a[end+1],a.slice(end+2),{env,stdio:'inherit'});process.exit(r.status??1);`,
			);
			// biome-ignore lint/suspicious/noTemplateCurlyInString: verify literal shell syntax survives systemd arguments.
			const unusual = "quotes '\" ${HOME} $HOME %u `echo wrong`\n日本語";
			const command = boxSystemdProcessCommand(
				{
					command: process.execPath,
					tag: "runtime",
					args: [
						"-e",
						"console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,account:process.env.BOX_ACCOUNT_VALUE,explicit:process.env.ZUSE_EXPLICIT_VALUE,user:process.env.USER}))",
					],
					cwd: directory,
					user: "zuse",
					env: { ZUSE_EXPLICIT_VALUE: unusual },
				},
				boxProcessUnit("zuse", "runtime"),
				{ tag: "runtime" },
			);
			const execution = promisify(execFile)(
				"bash",
				["-c", sandboxedCommand(command, directory)],
				{
					timeout: 5000,
					env: {
						...process.env,
						PATH: `${directory}:${process.env.PATH}`,
						BOX_ACCOUNT_VALUE: unusual,
					},
				},
			);
			if (stopFails) {
				await expect(execution).rejects.toMatchObject({ code: 1 });
				await expect(readFile(capture)).rejects.toMatchObject({
					code: "ENOENT",
				});
			} else {
				const result = await execution;
				expect(JSON.parse(result.stdout)).toEqual({
					cwd: directory,
					home: targetHome,
					account: unusual,
					explicit: unusual,
					user: "zuse",
				});
				expect(
					await readFile(join(targetHome, ".zuse-processes"), "utf8"),
				).toBe("unwritable legacy path");
				const captured = JSON.parse(await readFile(capture, "utf8"));
				expect(captured.args).toContain("--property=Restart=no");
				expect(captured.args).toContain("--expand-environment=no");
				expect(captured.args).toContain("--property=KillMode=control-group");
				expect(captured.env).not.toHaveProperty("SUDO_USER");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
