import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installFakeAcpProvider } from "../../src/fake-acp.ts";
import {
	makeHermeticEnvironment,
	makeTemporaryDirectory,
	spawnManaged,
} from "../../src/process.ts";

describe("deterministic ACP provider", () => {
	it("installs an executable that supports provider version probes", async () => {
		const temporary = makeTemporaryDirectory("zuse-testkit-");
		try {
			const installation = installFakeAcpProvider({ root: temporary.path });
			expect(existsSync(join(installation.binDirectory, "gemini"))).toBe(true);
			expect(existsSync(join(installation.binDirectory, "git"))).toBe(true);
			const process = spawnManaged(installation.executable, ["--version"], {
				cwd: temporary.path,
				env: makeHermeticEnvironment({ PATH: installation.binDirectory }),
			});
			const line = await process.waitForStdout(
				(candidate) => candidate.includes("0.0.0-zuse-test"),
				"fake provider version",
			);
			expect(line).toBe("0.0.0-zuse-test");
			await process.stop();

			const unavailable = spawnManaged("which", ["host-provider-cli"], {
				cwd: temporary.path,
				env: makeHermeticEnvironment({ PATH: installation.binDirectory }),
			});
			expect(await unavailable.waitForExit()).not.toBe(0);
		} finally {
			temporary.dispose();
		}
	});
});
