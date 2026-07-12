import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installFakeAcpProvider } from "../../src/fake-acp.ts";
import {
	makeHermeticEnvironment,
	makeTemporaryDirectory,
	spawnManaged,
	withResourceScope,
} from "../../src/process.ts";

describe("deterministic ACP provider", () => {
	it("installs an executable that supports provider version probes", async () => {
		await withResourceScope(async (resources) => {
			const temporary = await resources.acquire(
				() => makeTemporaryDirectory("zuse-testkit-"),
				(value) => value.dispose(),
			);
			const installation = installFakeAcpProvider({ root: temporary.path });
			expect(existsSync(join(installation.binDirectory, "gemini"))).toBe(true);
			expect(existsSync(join(installation.binDirectory, "git"))).toBe(true);
			const process = await resources.acquire(
				() =>
					spawnManaged(installation.executable, ["--version"], {
						cwd: temporary.path,
						env: makeHermeticEnvironment({ PATH: installation.binDirectory }),
					}),
				(value) => value.stop(),
			);
			const line = await process.waitForStdout(
				(candidate) => candidate.includes("0.0.0-zuse-test"),
				"fake provider version",
			);
			expect(line).toBe("0.0.0-zuse-test");

			const unavailable = await resources.acquire(
				() =>
					spawnManaged("which", ["host-provider-cli"], {
						cwd: temporary.path,
						env: makeHermeticEnvironment({ PATH: installation.binDirectory }),
					}),
				(value) => value.stop(),
			);
			expect(await unavailable.waitForExit()).not.toBe(0);
		});
	});
});
