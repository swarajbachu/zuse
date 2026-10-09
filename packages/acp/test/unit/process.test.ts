import { describe, expect, it } from "vitest";
import { launchAcpProcess } from "../../src/process.js";

describe("ACP process lifecycle", () => {
	it("removes inherited auth overrides from the actual child environment", async () => {
		const child = launchAcpProcess(
			{
				command: process.execPath,
				args: [
					"-e",
					`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{token:process.env.ZUSE_TEST_AUTH_TOKEN,home:process.env.CODEX_HOME}})+'\\n'))`,
				],
				env: {
					ZUSE_TEST_AUTH_TOKEN: "must-not-reach-child",
					CODEX_HOME: "/accounts/work",
				},
				unsetEnv: ["ZUSE_TEST_AUTH_TOKEN"],
			},
			process.cwd(),
			() => {},
		);
		try {
			expect(await child.rpc.request("initialize", {})).toEqual({
				home: "/accounts/work",
			});
		} finally {
			child.close();
		}
	});
	it("rejects pending requests on malformed output", async () => {
		const child = launchAcpProcess(
			{
				command: process.execPath,
				args: [
					"-e",
					'process.stdin.once("data",()=>process.stdout.write("bad-json\\n"))',
				],
			},
			process.cwd(),
			() => {},
		);
		try {
			await expect(child.rpc.request("initialize", {})).rejects.toThrow(
				"malformed",
			);
			expect(child.rpc.pendingCount).toBe(0);
		} finally {
			child.close();
		}
	});
	it("reports early process exit", async () => {
		const child = launchAcpProcess(
			{ command: process.execPath, args: ["-e", "process.exit(42)"] },
			process.cwd(),
			() => {},
		);
		try {
			await expect(child.rpc.request("initialize", {})).rejects.toThrow("42");
		} finally {
			child.close();
		}
	});
	it("bounds unanswered requests and closes idempotently", async () => {
		const child = launchAcpProcess(
			{ command: process.execPath, args: ["-e", "process.stdin.resume()"] },
			process.cwd(),
			() => {},
		);
		await expect(
			child.rpc.request("initialize", {}, { timeoutMs: 30 }),
		).rejects.toThrow("timed out");
		child.close();
		child.close();
		expect(child.rpc.pendingCount).toBe(0);
	});
	it("delivers stderr as whole lines when a URL spans chunks", async () => {
		const url = `https://accounts.google.com/o/oauth2/v2/auth?state=${"x".repeat(300)}`;
		const lines: string[] = [];
		const closed = new Promise<void>((resolve) => {
			const child = launchAcpProcess(
				{
					command: process.execPath,
					args: [
						"-e",
						`const u=${JSON.stringify(url)};process.stderr.write("Open "+u.slice(0,40));setTimeout(()=>process.stderr.write(u.slice(40)+"\\nlast"),20);`,
					],
				},
				process.cwd(),
				() => {},
				() => resolve(),
				(line) => lines.push(line),
			);
			setTimeout(() => child.close(), 2_000);
		});
		await closed;
		expect(lines).toEqual([`Open ${url}`, "last"]);
	});
});
