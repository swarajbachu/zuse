import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { waitForEngineEndpoint } from "../../src/engine-readiness.ts";

it("waits for a delayed engine and reports an explicit startup timeout", async () => {
	const root = await mkdtemp(join(tmpdir(), "engine-readiness-"));
	try {
		await expect(waitForEngineEndpoint(root, 1)).rejects.toThrow(
			"startup deadline",
		);
		const ready = waitForEngineEndpoint(root, 2_000);
		await mkdir(join(root, "engine"));
		await writeFile(
			join(root, "engine", "endpoint.json"),
			JSON.stringify({
				version: 1,
				port: 1234,
				apiPort: 1235,
				token: "a".repeat(64),
				pid: 123,
				appVersion: "test",
			}),
		);
		expect((await ready).pid).toBe(123);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
