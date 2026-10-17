import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("missing Bun exits with an actionable startup error", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/dev.mjs", "--instance", "missing-bun-test"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, PATH: "", Path: "" },
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /failed to start.*bun/);
	assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

test("a corrupt default endpoint does not abort occupied-port scanning", async () => {
	const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
	const { createServer } = await import("node:net");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "zuse-corrupt-endpoint-"));
	const listener = createServer();
	await new Promise((resolve, reject) => {
		listener.once("error", (error) =>
			error.code === "EADDRINUSE" ? resolve() : reject(error),
		);
		listener.listen(8788, "127.0.0.1", resolve);
	});
	try {
		const profile =
			process.platform === "darwin"
				? join(root, "Library", "Application Support", "Zuse Alpha (Dev)")
				: join(root, "Zuse Alpha (Dev)");
		await mkdir(join(profile, "engine"), { recursive: true });
		await writeFile(join(profile, "engine", "endpoint.json"), "{broken");
		const env = {
			...process.env,
			HOME: root,
			USERPROFILE: root,
			APPDATA: root,
			XDG_CONFIG_HOME: root,
			PATH: "",
			Path: "",
		};
		for (const key of [
			"ZUSE_DEV_INSTANCE",
			"ZUSE_USER_DATA_DIR",
			"ZUSE_PORT_OFFSET",
			"PORT",
			"ZUSE_DESKTOP_WS_PORT",
		])
			delete env[key];
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/dev.mjs"],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env,
				encoding: "utf8",
				timeout: 15_000,
			},
		);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /failed to start.*bun/);
		assert.doesNotMatch(result.stderr, /endpoint is invalid/);
	} finally {
		if (listener.listening)
			await new Promise((resolve) => listener.close(resolve));
		await rm(root, { recursive: true, force: true });
	}
});
