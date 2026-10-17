import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawn, spawnSync } from "../../src/spawn-command.ts";

const values = ["space value", 'quoted "value"', "a&b", "x(y)", "hello ü", ""];

it("passes literal arguments to an executable without a shell", () => {
	const result = spawnSync(
		process.execPath,
		["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...values],
		{ encoding: "utf8" },
	);
	expect(result.error ?? null).toBeNull();
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual(values);
});

it.skipIf(process.platform !== "win32")(
	"launches an npm cmd shim in a Unicode path with literal arguments",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "zuse CLI ü-"));
		try {
			const bin = join(root, "node_modules", ".bin");
			await mkdir(bin, { recursive: true });
			const probe = join(root, "probe.cjs");
			const command = join(bin, "provider.cmd");
			await writeFile(
				probe,
				"console.log(JSON.stringify(process.argv.slice(2)))",
			);
			await writeFile(
				command,
				`@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`,
			);
			const child = spawn(command, values, { stdio: "pipe" });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (data) => {
				stdout += String(data);
			});
			child.stderr.on("data", (data) => {
				stderr += String(data);
			});
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			expect(code, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual(values);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
