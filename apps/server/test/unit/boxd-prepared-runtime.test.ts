import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareBoxdRuntime } from "../../src/serve/boxd-prepared-runtime.ts";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const path of directories.splice(0))
		await rm(path, { recursive: true, force: true });
});
const fixture = async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-prepared-"));
	directories.push(directory);
	const path = join(directory, "bootstrap.sh");
	await writeFile(path, "echo ready");
	const socketPath = join(directory, "runtime.sock");
	const activate = vi.fn(async () => {});
	servers.push(
		await prepareBoxdRuntime({ socketPath, files: [path], activate }),
	);
	const request = (body: unknown) =>
		new Promise<{ state: string }>((resolve, reject) => {
			const socket = connect(socketPath);
			let bytes = "";
			socket.on("error", reject);
			socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
			socket.on("data", (chunk) => {
				bytes += chunk;
			});
			socket.on("end", () => {
				try {
					resolve(JSON.parse(bytes));
				} catch (e) {
					reject(e);
				}
			});
		});
	const activation = {
		version: 1,
		action: "activate",
		bootstrap: path,
		files: [
			{ path, sha256: createHash("sha256").update("echo ready").digest("hex") },
		],
		env: {
			ZUSE_CLOUD_WORKSPACE_ID: "workspace-1",
			ZUSE_RUNTIME_GENERATION: "1",
			ZUSE_GATEWAY_EPOCH: "1",
			ZUSE_RUNTIME_BOOT_TOKEN: "one-time-token",
			ZUSE_CLOUD_WORKSPACE_ROOT: "/workspace",
			ZUSE_API_URL: "https://api.example.test",
		},
	};
	return { request, activate, activation };
};
test("snapshot preparation acquires no workspace services; activation is idempotent", async () => {
	const { request, activate, activation } = await fixture();
	expect((await request({ version: 1, action: "status" })).state).toBe(
		"prepared",
	);
	expect(activate).not.toHaveBeenCalled();
	expect((await request(activation)).state).toBe("active");
	expect((await request(activation)).state).toBe("active");
	expect(activate).toHaveBeenCalledTimes(1);
});
test("concurrent identities cannot share the preserved process", async () => {
	const { request, activate, activation } = await fixture();
	const results = await Promise.all([
		request(activation),
		request({
			...activation,
			env: { ...activation.env, ZUSE_CLOUD_WORKSPACE_ID: "workspace-2" },
		}),
	]);
	expect(results.map((r) => r.state).sort()).toEqual(["active", "conflict"]);
	expect(activate).toHaveBeenCalledTimes(1);
});
test("changed scripts fall back before any workspace services are acquired", async () => {
	const { request, activate, activation } = await fixture();
	expect((await request({ ...activation, files: [] })).state).toBe("cold");
	expect(activate).not.toHaveBeenCalled();
	expect((await request(activation)).state).toBe("cold");
	expect(activate).not.toHaveBeenCalled();
});
test("missing credentials and invalid environment are rejected", async () => {
	const { request, activate, activation } = await fixture();
	expect((await request({ ...activation, env: {} })).state).toBe("invalid");
	expect(
		(
			await request({
				...activation,
				env: { ...activation.env, "BAD-NAME": "value" },
			})
		).state,
	).toBe("invalid");
	expect(activate).not.toHaveBeenCalled();
});

test("an active runtime cannot be retired through a protocol mismatch", async () => {
	const { request, activate, activation } = await fixture();
	await request(activation);
	expect((await request({ ...activation, version: 2 })).state).toBe("conflict");
	expect(activate).toHaveBeenCalledTimes(1);
});
