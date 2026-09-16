import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite-plus";
import { expect, it } from "vitest";

it("prebundles CommonJS dependencies reached through optimized ESM packages", async () => {
	const root = resolve(import.meta.dirname, "../..");
	const cacheDir = await mkdtemp(join(tmpdir(), "zuse-vite-commonjs-"));
	const server = await createServer({
		root,
		configFile: resolve(root, "vite.config.ts"),
		cacheDir,
		logLevel: "silent",
		server: { host: "127.0.0.1", port: 0 },
	});
	try {
		await server.listen();
		const address = server.httpServer?.address();
		if (!address || typeof address === "string")
			throw new Error("Server not listening");
		const modulePath = resolve(
			root,
			"../../node_modules/html-parse-stringify/dist/html-parse-stringify.module.js",
		);
		const response = await fetch(
			`http://127.0.0.1:${address.port}/@fs${modulePath}`,
		);
		expect(response.ok).toBe(true);
		const transformed = await response.text();
		expect(transformed).not.toMatch(
			/import . from["'][^"']*node_modules\/void-elements\/index\.js/,
		);
	} finally {
		await server.close();
		await rm(cacheDir, { recursive: true, force: true });
	}
}, 30_000);
