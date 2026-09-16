import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
	boxProcessUnit,
	boxSystemdProcessCommand,
} from "../../src/box-process.ts";

describe("Box systemd process launcher", () => {
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
			const execution = promisify(execFile)("bash", ["-c", command], {
				timeout: 5000,
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					BOX_ACCOUNT_VALUE: unusual,
				},
			});
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
					await readFile(
						join(targetHome, ".zuse-processes/runtime.pid"),
						"utf8",
					),
				).toMatch(/^[0-9a-f-]+ [0-9]+\n$/u);
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
