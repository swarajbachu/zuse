import { execFileSync } from "node:child_process";
import {
	constants,
	createDecipheriv,
	generateKeyPairSync,
	privateDecrypt,
} from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	CODEX_GRANT_SOURCE,
	cloudAuthAuthorityLabel,
	parseDeviceLoginOutput,
} from "../../src/cloud-auth-authority.ts";

const grantAdditionalData = (sealed: Record<string, unknown>): Buffer =>
	Buffer.from(
		JSON.stringify({
			protocolVersion: sealed.protocolVersion,
			requestId: sealed.requestId,
			keyThumbprint: sealed.keyThumbprint,
			authorityIncarnationId: sealed.authorityIncarnationId,
			authorityEpoch: sealed.authorityEpoch,
		}),
	);

describe("cloud auth authority identity", () => {
	test("isolates deployments but remains stable across image updates", async () => {
		const label = (apiIssuer: string) =>
			Effect.runPromise(
				cloudAuthAuthorityLabel({
					accountId: "account_1",
					apiIssuer,
				}),
			);
		const production = await label("https://api.zuse.sh");

		expect(production).toMatch(/^zuse-auth-[a-f0-9]{32}$/u);
		await expect(label("https://api.zuse.sh")).resolves.toBe(production);
		await expect(label("https://api-staging.stuff.md")).resolves.not.toBe(
			production,
		);
	});
});

describe("cloud auth authority Codex grants", () => {
	test("seals access-only grants and idempotently rejects conflicting request reuse", () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-codex-grant-"));
		try {
			const authHome = join(directory, "authority");
			const cacheDirectory = join(authHome, "grant-cache");
			mkdirSync(cacheDirectory, { recursive: true });
			writeFileSync(
				join(authHome, "storage-incarnation-id"),
				"authority-incarnation",
			);
			writeFileSync(
				join(authHome, "grant-fingerprint.key"),
				Buffer.alloc(32, 7).toString("base64url"),
			);
			const jwtPayload = Buffer.from(
				JSON.stringify({
					exp: Math.floor(Date.now() / 1_000) + 3_600,
					"https://api.openai.com/auth": {
						chatgpt_account_id: "chatgpt-account",
						chatgpt_plan_type: "pro",
					},
				}),
			).toString("base64url");
			const accessToken = `e30.${jwtPayload}.signature`;
			const authFile = join(directory, "auth.json");
			writeFileSync(
				authFile,
				JSON.stringify({
					tokens: {
						access_token: accessToken,
						refresh_token: "authority-only-refresh-token",
						account_id: "chatgpt-account",
					},
				}),
			);
			const { publicKey, privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
			});
			const scriptPath = join(directory, "codex-grant.mjs");
			const requestPath = join(directory, "request.json");
			const resultPath = join(directory, "result.json");
			const cachePath = join(cacheDirectory, "request.json");
			writeFileSync(scriptPath, CODEX_GRANT_SOURCE);
			const request = {
				protocolVersion: 1,
				requestId: "550e8400-e29b-41d4-a716-446655440000",
				accountId: "account-1",
				workspaceId: "workspace-1",
				runtimeGeneration: 3,
				credentialPublicJwk: JSON.stringify(
					publicKey.export({ format: "jwk" }),
				),
				keyThumbprint: "runtime-key-thumbprint",
				reason: "initial",
				authorityIncarnationId: "authority-incarnation",
				authorityEpoch: 4,
			};
			writeFileSync(requestPath, JSON.stringify(request));
			const run = () =>
				execFileSync(
					process.execPath,
					[scriptPath, requestPath, resultPath, cachePath],
					{
						env: {
							...process.env,
							ZUSE_CLOUD_AUTH_HOME: authHome,
							ZUSE_CODEX_AUTH_FILE: authFile,
						},
					},
				);
			run();
			const firstText = readFileSync(resultPath, "utf8");
			expect(firstText).not.toContain(accessToken);
			expect(firstText).not.toContain("authority-only-refresh-token");
			const first = JSON.parse(firstText) as {
				readonly sealed: Record<string, unknown>;
			};
			const sealed = first.sealed;
			const contentKey = privateDecrypt(
				{
					key: privateKey,
					oaepHash: "sha256",
					padding: constants.RSA_PKCS1_OAEP_PADDING,
				},
				Buffer.from(String(sealed.wrappedKey), "base64url"),
			);
			const decipher = createDecipheriv(
				"aes-256-gcm",
				contentKey,
				Buffer.from(String(sealed.iv), "base64url"),
			);
			decipher.setAAD(grantAdditionalData(sealed));
			decipher.setAuthTag(Buffer.from(String(sealed.tag), "base64url"));
			const plaintext = JSON.parse(
				Buffer.concat([
					decipher.update(Buffer.from(String(sealed.ciphertext), "base64url")),
					decipher.final(),
				]).toString("utf8"),
			) as Record<string, unknown>;
			expect(plaintext).toMatchObject({
				zuseAccountId: "account-1",
				workspaceId: "workspace-1",
				runtimeGeneration: 3,
				accessToken,
			});
			run();
			expect(readFileSync(resultPath, "utf8")).toBe(firstText);

			writeFileSync(
				requestPath,
				JSON.stringify({ ...request, workspaceId: "workspace-conflict" }),
			);
			run();
			expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
				errorCode: "codex_grant_request_id_reused",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("cloud auth device-login output", () => {
	test("extracts the official Codex URL and one-time code through ANSI styling", () => {
		const output = [
			"Follow these steps to sign in with ChatGPT using device code authorization:",
			"1. Open this link in your browser and sign in to your account",
			" \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
			"2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
			" \u001b[94mABCD-EFGH\u001b[0m",
		].join("\n");

		expect(parseDeviceLoginOutput(output)).toEqual({
			verificationUrl: "https://auth.openai.com/codex/device",
			verificationCode: "ABCD-EFGH",
		});
	});

	test("does not mistake device-code authorization prose for a code", () => {
		expect(
			parseDeviceLoginOutput(
				"Sign in with ChatGPT using device code authorization",
			),
		).toEqual({});
	});

	test("accepts an ungrouped code printed on the line after the prompt", () => {
		expect(
			parseDeviceLoginOutput(
				"2. Enter this one-time code (expires soon)\n A1B2C3D4\n",
			),
		).toEqual({ verificationCode: "A1B2C3D4" });
	});

	test("extracts a labeled Grok device code", () => {
		expect(
			parseDeviceLoginOutput(
				"Open https://auth.x.ai/device\nDevice code: WXYZ-1234\n",
			),
		).toEqual({
			verificationUrl: "https://auth.x.ai/device",
			verificationCode: "WXYZ-1234",
		});
	});
});
