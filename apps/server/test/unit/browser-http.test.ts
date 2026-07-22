import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	browserCookieName,
	hasValidRequestOrigin,
	PairingRateLimiter,
	readStaticAsset,
	requestRequiresAuthentication,
	WebSocketTicketStore,
} from "../../src/transports/browser-http.ts";

describe("browser HTTP primitives", () => {
	it("serves hashed assets immutably and falls back to uncached SPA HTML", async () => {
		const root = await mkdtemp(join(tmpdir(), "zuse-static-"));
		await writeFile(join(root, "index.html"), "<main>Zuse</main>");
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(join(root, "assets")),
		);
		await writeFile(join(root, "assets", "app-a1b2c3d4.js"), "export {};");
		await writeFile(join(root, "assets", "runtime.js"), "export {};");

		const asset = await readStaticAsset(root, "/assets/app-a1b2c3d4.js");
		expect(asset).toMatchObject({
			contentType: "text/javascript; charset=utf-8",
			cacheControl: "public, max-age=31536000, immutable",
		});
		await expect(
			readStaticAsset(root, "/assets/runtime.js"),
		).resolves.toMatchObject({ cacheControl: "no-cache" });
		const fallback = await readStaticAsset(root, "/projects/example");
		expect(fallback).toMatchObject({
			contentType: "text/html; charset=utf-8",
			cacheControl: "no-cache",
		});
		await expect(
			readStaticAsset(root, "/assets/missing-a1b2c3d4.js"),
		).resolves.toBeNull();
	});

	it("rejects encoded traversal and null-byte paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "zuse-static-"));
		await writeFile(join(root, "index.html"), "safe");
		await expect(readStaticAsset(root, "/%2e%2e/secret")).resolves.toBe(
			"invalid",
		);
		await expect(readStaticAsset(root, "/asset%00.js")).resolves.toBe(
			"invalid",
		);
		const outside = await mkdtemp(join(tmpdir(), "zuse-static-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
		await expect(readStaticAsset(root, "/linked.txt")).resolves.toBe("invalid");
	});

	it("issues single-use expiring WebSocket tickets", () => {
		let now = 1_000;
		const store = new WebSocketTicketStore(100, () => now);
		const first = store.issue("credential-a");
		expect(store.consume(first.ticket)).toBe("credential-a");
		expect(store.consume(first.ticket)).toBeNull();

		const expired = store.issue("credential-b");
		now = 1_101;
		expect(store.consume(expired.ticket)).toBeNull();
	});

	it("rate limits repeated pairing attempts within a rolling window", () => {
		let now = 1_000;
		const limiter = new PairingRateLimiter(2, 100, () => now);
		expect(limiter.allow("client")).toBe(true);
		expect(limiter.allow("client")).toBe(true);
		expect(limiter.allow("client")).toBe(false);
		now = 1_101;
		expect(limiter.allow("client")).toBe(true);
	});

	it("bounds rotating pairing identities with a global window", () => {
		const limiter = new PairingRateLimiter(8, 100, () => 1_000, 4, 4);
		expect(limiter.allow("one")).toBe(true);
		expect(limiter.allow("two")).toBe(true);
		expect(limiter.allow("three")).toBe(true);
		expect(limiter.allow("four")).toBe(true);
		expect(limiter.allow("five")).toBe(false);
	});

	it("requires an exact scheme and host for mutation origins", () => {
		expect(hasValidRequestOrigin({ host: "localhost:8788" })).toBe(false);
		expect(
			hasValidRequestOrigin({
				host: "localhost:8788",
				origin: "http://localhost:8788",
			}),
		).toBe(true);
		expect(
			hasValidRequestOrigin({
				host: "localhost:8788",
				origin: "https://localhost:8788",
			}),
		).toBe(false);
	});

	it("derives environment-specific cookie names", () => {
		expect(browserCookieName("env_local/one")).toBe(
			"zuse_session_env_local_one",
		);
		expect(browserCookieName("env_local/two")).not.toBe(
			browserCookieName("env_local/one"),
		);
	});

	it("keeps direct loopback access local while protecting forwarded hosts", () => {
		expect(
			requestRequiresAuthentication("local", { host: "127.0.0.1:8788" }),
		).toBe(false);
		expect(
			requestRequiresAuthentication("local", { host: "localhost:8788" }),
		).toBe(false);
		expect(
			requestRequiresAuthentication("local", {
				host: "127.0.0.1:8788",
				"x-forwarded-host": "serve.example.test",
			}),
		).toBe(false);
		expect(
			requestRequiresAuthentication(
				"local",
				{
					host: "127.0.0.1:8788",
					"x-forwarded-host": "serve.example.test",
				},
				true,
			),
		).toBe(true);
		expect(
			requestRequiresAuthentication("protected", {
				host: "127.0.0.1:8788",
			}),
		).toBe(true);
	});
});
