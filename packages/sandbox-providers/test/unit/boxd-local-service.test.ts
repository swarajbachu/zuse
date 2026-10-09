import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { BOXD_LOCAL_SERVICE_CLIENT } from "../../src/boxd-local-service.ts";

const exec = promisify(execFile);
test("guest transport authenticates locally and never returns the bearer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "boxd-service-"));
	const token = "a".repeat(43);
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		expect(request.headers.authorization).toBe(`Bearer ${token}`);
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			expect(JSON.parse(body)).toEqual({ requestId: "same-request" });
			response.end('{"sealed":"ciphertext"}');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing port");
		const descriptorPath = join(directory, "service.json");
		await writeFile(
			descriptorPath,
			JSON.stringify({ token, incarnation: "storage-1", port: address.port }),
			{ mode: 0o600 },
		);
		const input = {
			descriptorPath,
			expectedIncarnation: "storage-1",
			port: address.port,
			path: "/grant",
			body: JSON.stringify({ requestId: "same-request" }),
		};
		const result = await exec(process.execPath, [
			"-e",
			BOXD_LOCAL_SERVICE_CLIENT,
			JSON.stringify(input),
		]);
		expect(result.stdout).toBe('{"sealed":"ciphertext"}');
		expect(result.stderr).toBe("");
		await expect(
			exec(process.execPath, [
				"-e",
				BOXD_LOCAL_SERVICE_CLIENT,
				JSON.stringify({ ...input, expectedIncarnation: "wrong-storage" }),
			]),
		).rejects.toMatchObject({ code: 2 });
		expect(requests).toBe(1);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
