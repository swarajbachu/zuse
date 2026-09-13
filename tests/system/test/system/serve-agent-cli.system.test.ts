import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import {
	makeHermeticEnvironment,
	spawnManaged,
	waitForFile,
} from "@zuse/testkit";
import { describe, expect, it } from "vitest";
import { withSystemTest } from "../../src/system-scope.ts";

const repoRoot = resolve(
	fileURLToPath(new NodeUrl("../../../../", import.meta.url)),
);
const sourceCli = join(repoRoot, "tests/system/src/serve-cli-process.ts");

const freePort = (): Promise<number> =>
	new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("no tcp port")));
				return;
			}
			server.close(() => resolvePort(address.port));
		});
	});

const runZusehq = async (
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>,
) => {
	const process = spawnManaged(
		join(repoRoot, "node_modules", ".bin", "tsx"),
		[sourceCli, ...args],
		{ cwd: repoRoot, env },
	);
	const exitCode = await process.waitForExit(20_000);
	return { exitCode, ...process.output() };
};

describe("Zuse Serve agent CLI", () => {
	it("discovers, authenticates, and refreshes local CLI access", async () => {
		await withSystemTest("zuse-serve-agent-cli-", async (scope) => {
			const port = await freePort();
			const dataDir = scope.path("serve-data");
			const accessFile = join(dataDir, "cli-access.json");
			const env = makeHermeticEnvironment({
				HOME: scope.path("home"),
				PATH: process.env.PATH,
				ZUSE_ENABLE_PAIRING: "0",
				ZUSE_SERVER_READY_STDOUT: "1",
				ZUSE_USER_DATA_DIR: dataDir,
			});
			const start = () =>
				spawnManaged(
					join(repoRoot, "node_modules", ".bin", "tsx"),
					[
						sourceCli,
						"serve",
						"--foreground",
						"--no-account",
						"--host",
						"127.0.0.1",
						"--port",
						String(port),
						"--data-dir",
						dataDir,
					],
					{ cwd: repoRoot, env },
				);

			const firstServer = start();
			scope.defer(() => firstServer.stop());
			await firstServer.waitForStdout(
				(line) => line.startsWith("ZUSE_SERVER_READY "),
				"Serve readiness",
				20_000,
			);
			await waitForFile(accessFile);
			const firstAccess = JSON.parse(await readFile(accessFile, "utf8")) as {
				readonly wsUrl: string;
				readonly token: string;
			};
			expect(firstAccess.wsUrl).toBe(`ws://127.0.0.1:${port}/rpc`);
			expect(firstAccess.token.length).toBeGreaterThan(20);
			expect((await stat(accessFile)).mode & 0o777).toBe(0o600);

			const connected = await runZusehq(["computer", "list"], env);
			expect(connected.exitCode).toBe(0);
			expect(connected.stderr).not.toContain("SocketOpenError");
			expect(JSON.parse(connected.stdout)).toMatchObject({
				schemaVersion: 1,
				ok: true,
			});

			await firstServer.stop();
			const secondServer = start();
			scope.defer(() => secondServer.stop());
			await secondServer.waitForStdout(
				(line) => line.startsWith("ZUSE_SERVER_READY "),
				"restarted Serve readiness",
				20_000,
			);
			await expect
				.poll(async () => JSON.parse(await readFile(accessFile, "utf8")).token)
				.not.toBe(firstAccess.token);
			const secondAccess = JSON.parse(await readFile(accessFile, "utf8")) as {
				readonly wsUrl: string;
				readonly token: string;
			};

			const restarted = await runZusehq(["computer", "list"], env);
			expect(restarted.exitCode).toBe(0);
			expect(JSON.parse(restarted.stdout)).toMatchObject({ ok: true });

			await writeFile(
				accessFile,
				JSON.stringify({ ...secondAccess, token: "stale-token" }),
			);
			await chmod(accessFile, 0o600);
			const stale = await runZusehq(["computer", "list"], env);
			expect(stale.exitCode).toBe(3);
			expect(JSON.parse(stale.stdout)).toMatchObject({
				ok: false,
				error: { code: "unauthorized" },
			});

			await secondServer.stop();
			const unavailable = await runZusehq(["computer", "list"], env);
			expect(unavailable.exitCode).toBe(1);
			expect(JSON.parse(unavailable.stdout)).toMatchObject({
				ok: false,
				error: { code: "server_unavailable" },
			});
		});
	}, 90_000);
});
