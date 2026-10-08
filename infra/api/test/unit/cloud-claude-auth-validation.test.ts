import { execFileSync } from "node:child_process";
import { constants, generateKeyPairSync, publicEncrypt } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CLAUDE_AUTH_VALIDATION_SOURCE } from "../../src/cloud-claude-auth-validation.ts";

function verify(reply: unknown, exitCode = 0) {
	const dir = mkdtempSync(join(tmpdir(), "claude-validation-test-"));
	try {
		const cli = join(dir, "claude");
		writeFileSync(
			cli,
			`#!${process.execPath}\nif(process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'sk-ant-oat01-example' || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_BASE_URL) process.exit(9);\nconsole.log(${JSON.stringify(JSON.stringify(reply))});\nprocess.exit(${exitCode});\n`,
		);
		chmodSync(cli, 0o700);
		const script = join(dir, "test.mjs");
		writeFileSync(
			script,
			`${CLAUDE_AUTH_VALIDATION_SOURCE}\nconsole.log(JSON.stringify(await verifyClaudeCredential({method:'subscription',secret:normalizeClaudeSetupToken(' sk-ant-oat01-exam  ple\\n')})));`,
		);
		return JSON.parse(
			execFileSync(process.execPath, [script], {
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					ANTHROPIC_API_KEY: "unrelated-valid-key",
					ANTHROPIC_AUTH_TOKEN: "unrelated-token",
					ANTHROPIC_BASE_URL: "https://unrelated.test",
				},
				encoding: "utf8",
			}),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("normalizes pasted setup token and verifies only that credential with a successful turn", () => {
	expect(
		verify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "OK",
		}),
	).toEqual({ code: 0 });
});

test("CLI login status alone cannot report a successful connection", () => {
	expect(verify({ loggedIn: true })).toEqual({
		code: 1,
		error: "verification-failed",
	});
});

test("rejects authentication errors even when the CLI exits zero", () => {
	expect(
		verify({
			type: "result",
			subtype: "success",
			is_error: true,
			result:
				"Failed to authenticate. API Error: 401 OAuth access token is invalid.",
		}),
	).toEqual({ code: 1, error: "authentication-required" });
});

test("keeps network failures distinct from expired credentials", () => {
	expect(
		verify(
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				result: "Connection timed out",
			},
			1,
		),
	).toEqual({ code: 1, error: "verification-failed" });
});

test("the configurator saves normalized tokens only after a successful Claude request", async () => {
	const { CONFIGURATOR_SOURCE } = await import(
		"../../src/cloud-auth-authority.ts"
	);
	const dir = mkdtempSync(join(tmpdir(), "claude-configurator-test-"));
	try {
		const home = join(dir, ".zuse/cloud-auth");
		mkdirSync(join(home, "status"), { recursive: true });
		const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		writeFileSync(join(home, "key-id"), "test-key");
		writeFileSync(
			join(home, "private.pem"),
			pair.privateKey.export({ type: "pkcs8", format: "pem" }),
		);
		const cli = join(dir, "claude");
		writeFileSync(
			cli,
			`#!${process.execPath}\nconst ok=process.argv.includes('-p') && process.env.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-example';console.log(JSON.stringify({type:'result',subtype:'success',is_error:!ok,result:ok?'OK':'401 OAuth access token is invalid'}));`,
		);
		chmodSync(cli, 0o700);
		const script = join(dir, "configure.mjs");
		writeFileSync(script, CONFIGURATOR_SOURCE.replaceAll("/home/zuse", dir));
		const request = join(dir, "request.json");
		const result = join(dir, "result.json");
		const run = (secret: string) => {
			writeFileSync(
				request,
				JSON.stringify({
					providerId: "claude",
					method: "subscription",
					sealedSecret: {
						keyId: "test-key",
						ciphertext: publicEncrypt(
							{
								key: pair.publicKey,
								oaepHash: "sha256",
								padding: constants.RSA_PKCS1_OAEP_PADDING,
							},
							Buffer.from(secret),
						).toString("base64url"),
					},
				}),
			);
			execFileSync(process.execPath, [script, request, result], {
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
			});
			return JSON.parse(readFileSync(result, "utf8"));
		};
		expect(run("sk-ant-oat01-invalid").state).toBe("expired");
		expect(existsSync(join(home, "providers/claude.json"))).toBe(false);
		expect(run("sk-ant-oat01-exam  ple").state).toBe("connected");
		expect(
			JSON.parse(readFileSync(join(home, "providers/claude.json"), "utf8"))
				.secret,
		).toBe("sk-ant-oat01-example");
		expect(run("sk-ant-oat01-invalid").state).toBe("expired");
		expect(
			JSON.parse(readFileSync(join(home, "providers/claude.json"), "utf8"))
				.secret,
		).toBe("sk-ant-oat01-example");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
