import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AUTH_GRANT_MODULE_SOURCE } from "../../src/cloud-auth-authority.ts";
import { AUTH_GRANT_SERVICE_SOURCE } from "../../src/cloud-auth-grant-service.ts";

test("persistent grants authenticate, serialize retries, fence storage, and survive bad requests", async () => {
	const home = await mkdtemp(join(tmpdir(), "zuse-auth-service-"));
	const version = createHash("sha256")
		.update(AUTH_GRANT_MODULE_SOURCE)
		.digest("hex");
	for (const directory of ["bootstrap", "providers", "grant-cache"])
		await mkdir(join(home, directory));
	await writeFile(join(home, "storage-incarnation-id"), "incarnation");
	await writeFile(
		join(home, "grant-fingerprint.key"),
		Buffer.alloc(32, 7).toString("base64url"),
	);
	await writeFile(
		join(home, "providers/cursor.json"),
		JSON.stringify({ method: "api-key", secret: "private-provider-secret" }),
	);
	await writeFile(
		join(home, `bootstrap/grant-${version}.mjs`),
		AUTH_GRANT_MODULE_SOURCE,
	);
	const script = join(home, "service.mjs");
	await writeFile(script, AUTH_GRANT_SERVICE_SOURCE);
	const child = spawn(process.execPath, [script], {
		env: {
			...process.env,
			ZUSE_CLOUD_AUTH_HOME: home,
			ZUSE_AUTH_GRANT_PORT: "0",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		let descriptor: { token: string; port: number } | undefined;
		for (
			let attempt = 0;
			attempt < 100 && descriptor === undefined;
			attempt++
		) {
			try {
				descriptor = JSON.parse(
					await readFile(join(home, "grant-service.json"), "utf8"),
				);
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		if (descriptor === undefined)
			throw new Error(`Service did not start: ${stderr}`);
		const url = `http://127.0.0.1:${descriptor.port}/grant`;
		const headers = {
			authorization: `Bearer ${descriptor.token}`,
			"content-type": "application/json",
		};
		const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const input = {
			protocolVersion: 1,
			providerId: "cursor",
			requestId: crypto.randomUUID(),
			accountId: "account",
			workspaceId: "workspace",
			runtimeGeneration: 1,
			credentialPublicJwk: JSON.stringify(publicKey.export({ format: "jwk" })),
			keyThumbprint: "thumbprint",
			authorityIncarnationId: "incarnation",
			authorityEpoch: 1,
			reason: "initial",
		};
		const send = (overrides = {}) =>
			fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ version, input: { ...input, ...overrides } }),
				signal: AbortSignal.timeout(5000),
			});
		expect((await fetch(url, { method: "POST" })).status).toBe(401);
		expect(
			(await fetch(url, { method: "POST", headers, body: "invalid" })).status,
		).toBe(503);
		expect((await send({ authorityIncarnationId: "other" })).status).toBe(409);
		expect((await send({ requestId: "../../other" })).status).toBe(400);
		const started = performance.now();
		const responses = await Promise.all([send(), send()]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		const bodies = await Promise.all(
			responses.map((response) => response.text()),
		);
		expect(bodies[0]).toBe(bodies[1]);
		expect(bodies[0]).not.toContain("private-provider-secret");
		expect(JSON.parse(bodies[0] ?? "{}").sealed.providerId).toBe("cursor");
		expect(
			await (await send({ workspaceId: "different-workspace" })).json(),
		).toEqual({ errorCode: "cursor_grant_request_id_reused" });
		console.info("[auth-service-test] concurrent sealed grant round trip", {
			durationMs: Math.round(performance.now() - started),
		});
		expect(child.exitCode).toBeNull();
	} finally {
		if (child.exitCode === null) {
			child.kill();
			await once(child, "exit");
		}
		await rm(home, { recursive: true, force: true });
	}
}, 10_000);
