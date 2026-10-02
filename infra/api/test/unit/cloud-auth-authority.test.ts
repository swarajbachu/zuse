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
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CloudAuthStatus,
	CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
	GROK_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
} from "@zuse/contracts";
import {
	makeSandboxProviders,
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	AUTH_GRANT_SOURCE,
	AUTH_INITIALIZER_SOURCE,
	CODEX_GRANT_SOURCE,
	canSeedCloudAuthSnapshot,
	cloudAuthAuthorityLabel,
	cloudAuthStatus,
	parseDeviceLoginOutput,
	pollCloudAuthLogin,
	provisionCloudAuth,
	snapshotCloudAuthAuthority,
	startCloudAuthLogin,
} from "../../src/cloud-auth-authority.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";

const grantAdditionalData = (sealed: Record<string, unknown>): Buffer =>
	Buffer.from(
		JSON.stringify({
			protocolVersion: sealed.protocolVersion,
			...(typeof sealed.providerId === "string"
				? { providerId: sealed.providerId }
				: {}),
			requestId: sealed.requestId,
			keyThumbprint: sealed.keyThumbprint,
			authorityIncarnationId: sealed.authorityIncarnationId,
			authorityEpoch: sealed.authorityEpoch,
		}),
	);

describe("cloud auth setup reuse", () => {
	test.each([
		"e2b",
		"boxd",
	])("passive status never resumes a paused %s authority", async (providerId) => {
		let resumes = 0;
		let inspections = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				yield* store.claimCloudAuthAuthority({
					accountId: "account",
					provider: providerId,
					candidateStorageIncarnationId: "incarnation",
					toolchainVersion: "test",
					leaseOwner: "worker",
					nowMs: 100,
					leaseExpiresAtMs: 200,
				});
				yield* store.completeCloudAuthAuthorityProvisioning({
					accountId: "account",
					providerSandboxId: "authority",
					storageIncarnationId: "incarnation",
					toolchainVersion: "test",
					leaseOwner: "worker",
					nowMs: 150,
				});
				const fake = yield* (yield* SandboxProviders).get("fake");
				const registry = yield* makeSandboxProviders({
					registrations: [
						{
							adapter: {
								...fake,
								providerId,
								inspect: () => {
									inspections++;
									return Effect.succeed({
										providerSandboxId: "authority",
										providerLabel: "authority",
										state: "paused" as const,
									});
								},
								resume: () => {
									resumes++;
									return Effect.fail(
										new SandboxProviderError({
											code: "transient",
										}),
									);
								},
							},
						},
					],
					defaultProviderId: providerId,
				});
				const uncached = yield* cloudAuthStatus("account").pipe(
					Effect.provideService(SandboxProviders, registry),
				);
				expect(uncached.providers[0]?.errorCode).toBe(
					"cloud_auth_status_refresh_required",
				);
				expect(resumes).toBe(0);
				expect(inspections).toBe(0);
				const expired = yield* pollCloudAuthLogin(
					"account",
					crypto.randomUUID(),
				).pipe(
					Effect.provideService(SandboxProviders, registry),
					Effect.result,
				);
				expect(expired._tag).toBe("Failure");
				if (expired._tag === "Failure")
					expect(expired.failure.code).toBe("cloud_auth_operation_expired");
				expect(resumes).toBe(0);
				const locator = yield* store.getCloudAuthAuthority("account");
				const status = new CloudAuthStatus({
					authorityState: "ready",
					providers: [{ providerId: "grok", state: "connected" }],
					updatedAt: 150,
				});
				yield* store.saveCloudAuthStatus({
					accountId: "account",
					expectedRevision: locator?.revision ?? -1,
					status,
				});
				// No registry at all: cached reads must not touch the provider.
				expect(yield* cloudAuthStatus("account")).toEqual(status);
				yield* store.saveCloudAuthStatus({
					accountId: "account",
					expectedRevision: locator?.revision ?? -1,
					status: new CloudAuthStatus({ ...status, providers: [] }),
				});
				expect(yield* cloudAuthStatus("account")).toEqual(status);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						CloudWorkspaceStoreMemory,
						SandboxProvidersFake,
						Config.layer({
							apiIssuer: "https://api.test",
							workosJwksUrl: "https://unused.test/jwks",
							workosIssuer: "https://unused.test",
							mintPrivateKey: Redacted.make("{}"),
							mintPublicKey: "{}",
							cloudAuthProviderId: "fake",
						}),
					),
				),
			),
		);
	});
	test("initializes once across status, connect and device login, and repairs stale setup", async () => {
		const home = "/home/zuse/.zuse/cloud-auth";
		const files = new Map<string, string>();
		let initializations = 0;
		let failGrok = false;
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				yield* store.claimCloudAuthAuthority({
					accountId: "account",
					provider: "fake",
					candidateStorageIncarnationId: "incarnation",
					toolchainVersion: "test",
					leaseOwner: "worker",
					nowMs: 100,
					leaseExpiresAtMs: 200,
				});
				yield* store.completeCloudAuthAuthorityProvisioning({
					accountId: "account",
					providerSandboxId: "authority",
					storageIncarnationId: "incarnation",
					toolchainVersion: "test",
					leaseOwner: "worker",
					nowMs: 150,
				});
				const fake = yield* (yield* SandboxProviders).get("fake");
				const registry = yield* makeSandboxProviders({
					registrations: [
						{
							adapter: {
								...fake,
								inspect: () =>
									Effect.succeed({
										providerSandboxId: "authority",
										providerLabel: "authority",
										state: "running" as const,
									}),
								extendTimeout: (_id, seconds) =>
									Effect.sync(() => {
										expect(seconds).toBe(15 * 60);
									}),
								pathExists: (_id, path) => Effect.succeed(files.has(path)),
								readTextFile: (_id, path) =>
									Effect.succeed(files.get(path) ?? ""),
								writeTextFile: (_id, path, contents) =>
									Effect.sync(() => {
										files.set(path, contents);
									}),
								startProcess: (_id, spec) =>
									Effect.sync(() => {
										if (spec.tag !== "zuse-cloud-auth-initialize") return;
										initializations++;
										files.set(spec.args?.at(-1) ?? "", "ready");
										files.set(`${home}/key-id`, "key");
										files.set(`${home}/private.pem`, "private");
										files.set(
											`${home}/grok-toolchain-version`,
											failGrok
												? "unavailable"
												: GROK_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
										);
										files.set(`${home}/public.jwk.json`, "{}");
										files.set(`${home}/storage-incarnation-id`, "incarnation");
										files.set(
											`${home}/codex-toolchain-version`,
											CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION,
										);
									}),
							},
						},
					],
					defaultProviderId: "fake",
				});
				yield* Effect.gen(function* () {
					expect((yield* provisionCloudAuth("account")).authorityState).toBe(
						"ready",
					);
					yield* provisionCloudAuth("account");
					expect((yield* startCloudAuthLogin("account", "codex")).state).toBe(
						"authorizing",
					);
					expect(initializations).toBe(1);
					files.set(`${home}/bootstrap-version`, "old-version");
					yield* cloudAuthStatus("account");
					expect(initializations).toBe(1);
					yield* provisionCloudAuth("account");
					expect(initializations).toBe(2);
					files.delete(`${home}/key-id`);
					yield* provisionCloudAuth("account");
					expect(initializations).toBe(3);
					files.delete(`${home}/private.pem`);
					failGrok = true;
					yield* provisionCloudAuth("account");
					expect(initializations).toBe(4);
					expect(files.get(`${home}/bootstrap-version`)).toBe("");
					failGrok = false;
					yield* provisionCloudAuth("account");
					expect(initializations).toBe(5);
					yield* cloudAuthStatus("account");
					expect(initializations).toBe(5);
				}).pipe(Effect.provideService(SandboxProviders, registry));
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						CloudWorkspaceStoreMemory,
						SandboxProvidersFake,
						Config.layer({
							apiIssuer: "https://api.test",
							workosJwksUrl: "https://unused.test/jwks",
							workosIssuer: "https://unused.test",
							mintPrivateKey: Redacted.make("{}"),
							mintPublicKey: "{}",
						}),
					),
				),
			),
		);
	});
});

describe("cloud auth authority identity", () => {
	test.each([
		"boxd",
		"e2b",
	])("uses persisted %s authority after configuration changes", async (providerId) => {
		let resumed = false;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				yield* store.claimCloudAuthAuthority({
					accountId: "account",
					provider: providerId,
					candidateStorageIncarnationId: "incarnation",
					toolchainVersion: "test",
					leaseOwner: "worker",
					nowMs: 100,
					leaseExpiresAtMs: 200,
				});
				yield* store.completeCloudAuthAuthorityProvisioning({
					accountId: "account",
					providerSandboxId: "authority",
					storageIncarnationId: "incarnation",
					toolchainVersion: "test",
					leaseOwner: "worker",
					nowMs: 150,
				});
				const fake = yield* (yield* SandboxProviders).get("fake");
				const registry = yield* makeSandboxProviders({
					registrations: [
						{
							adapter: {
								...fake,
								providerId,
								inspect: () =>
									Effect.succeed({
										providerSandboxId: "authority",
										providerLabel: "authority",
										state: "paused" as const,
									}),
								resume: () => {
									resumed = true;
									return Effect.fail(
										new SandboxProviderError({ code: "transient" }),
									);
								},
							},
						},
					],
					defaultProviderId: providerId,
				});
				return yield* snapshotCloudAuthAuthority(
					"account",
					"image",
					"e2b",
				).pipe(Effect.provideService(SandboxProviders, registry), Effect.exit);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						CloudWorkspaceStoreMemory,
						SandboxProvidersFake,
						Config.layer({
							apiIssuer: "https://api.test",
							workosJwksUrl: "https://unused.test/jwks",
							workosIssuer: "https://unused.test",
							mintPrivateKey: Redacted.make("{}"),
							mintPublicKey: "{}",
							cloudAuthProviderId: providerId === "boxd" ? "e2b" : "boxd",
						}),
					),
				),
			),
		);
		// Stop at resume: only the persisted E2B authority may reach snapshot preparation.
		expect(resumed).toBe(providerId === "e2b");
		expect(result._tag).toBe(providerId === "e2b" ? "Failure" : "Success");
	});

	test("does not seed a Box image with an E2B snapshot", async () => {
		await expect(
			Effect.runPromise(
				snapshotCloudAuthAuthority("account", "image", "box") as Effect.Effect<
					string | undefined
				>,
			),
		).resolves.toBeUndefined();
	});
	test("seeds images only when the authority and the image both live on E2B", () => {
		expect(canSeedCloudAuthSnapshot("e2b")).toBe(true);
		expect(canSeedCloudAuthSnapshot("e2b", "e2b")).toBe(true);
		expect(canSeedCloudAuthSnapshot("e2b", "boxd")).toBe(false);
		expect(canSeedCloudAuthSnapshot("boxd", "boxd")).toBe(false);
		expect(canSeedCloudAuthSnapshot("box", "e2b")).toBe(false);
	});
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
		await expect(label("https://api-staging.zuse.sh")).resolves.not.toBe(
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
				credentialKind: "chatgpt",
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

	test("serves an account API key only to runtimes that accept it", () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-codex-api-key-grant-"));
		try {
			const authHome = join(directory, "authority");
			mkdirSync(join(authHome, "grant-cache"), { recursive: true });
			mkdirSync(join(authHome, "providers"), { recursive: true });
			writeFileSync(
				join(authHome, "storage-incarnation-id"),
				"authority-incarnation",
			);
			writeFileSync(
				join(authHome, "grant-fingerprint.key"),
				Buffer.alloc(32, 7).toString("base64url"),
			);
			writeFileSync(
				join(authHome, "providers", "codex.json"),
				JSON.stringify({
					providerId: "codex",
					method: "api-key",
					secret: "sk-account-api-key",
					updatedAt: Date.now(),
				}),
			);
			const { publicKey, privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
			});
			const scriptPath = join(directory, "codex-grant.mjs");
			const requestPath = join(directory, "request.json");
			const resultPath = join(directory, "result.json");
			writeFileSync(scriptPath, CODEX_GRANT_SOURCE);
			const request = {
				protocolVersion: 1,
				requestId: "550e8400-e29b-41d4-a716-446655440001",
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
			const run = (body: Record<string, unknown>, cacheName: string) => {
				writeFileSync(requestPath, JSON.stringify(body));
				execFileSync(
					process.execPath,
					[
						scriptPath,
						requestPath,
						resultPath,
						join(authHome, "grant-cache", cacheName),
					],
					{
						env: {
							...process.env,
							ZUSE_CLOUD_AUTH_HOME: authHome,
							ZUSE_CODEX_AUTH_FILE: join(directory, "missing-auth.json"),
						},
					},
				);
				return JSON.parse(readFileSync(resultPath, "utf8")) as {
					readonly errorCode?: string;
					readonly sealed?: Record<string, unknown>;
				};
			};

			// A runtime that predates API-key brokering keeps its old behavior.
			expect(run(request, "legacy.json")).toEqual({
				errorCode: "codex-auth-reconnect-required",
			});

			const result = run(
				{
					...request,
					requestId: "550e8400-e29b-41d4-a716-446655440002",
					acceptsApiKey: true,
				},
				"accepting.json",
			);
			expect(JSON.stringify(result)).not.toContain("sk-account-api-key");
			const sealed = result.sealed as Record<string, unknown>;
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
				workspaceId: "workspace-1",
				credentialKind: "api-key",
				apiKey: "sk-account-api-key",
			});
			expect(plaintext).not.toHaveProperty("accessToken");
			expect(Number(plaintext.expiresAt)).toBeGreaterThan(Date.now());
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("cloud auth authority provider grants", () => {
	test("reconciles the pinned Grok toolchain for retained authorities", () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-auth-initialize-"));
		try {
			const authHome = join(directory, "authority");
			const systemGrok = join(directory, "system", "grok");
			const managedGrok = join(directory, "managed", "grok");
			const completionPath = join(directory, "initialize.done");
			const scriptPath = join(directory, "initialize.mjs");
			mkdirSync(join(directory, "system"), { recursive: true });
			writeFileSync(
				systemGrok,
				"#!/usr/bin/env bash\nprintf 'grok 1.0.13\\n'\n",
				{ mode: 0o755 },
			);
			writeFileSync(
				join(directory, "system", "codex"),
				`#!/bin/sh\nprintf 'codex-cli ${CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION}\\n'\n`,
				{ mode: 0o755 },
			);
			writeFileSync(scriptPath, AUTH_INITIALIZER_SOURCE);

			execFileSync(process.execPath, [scriptPath, completionPath], {
				env: {
					...process.env,
					PATH: `${join(directory, "system")}:${process.env.PATH}`,
					ZUSE_AUTH_MANAGED_GROK_BINARY: managedGrok,
					ZUSE_AUTH_SYSTEM_GROK_BINARY: systemGrok,
					ZUSE_CLOUD_AUTH_HOME: authHome,
				},
			});

			expect(readlinkSync(managedGrok)).toBe(systemGrok);
			expect(
				readFileSync(join(authHome, "grok-toolchain-version"), "utf8"),
			).toContain("1.0.13");
			expect(readFileSync(completionPath, "utf8")).toBe("ready");
			expect(AUTH_GRANT_SOURCE).toContain(
				'const grokBinary = process.env.ZUSE_GROK_BINARY ?? "/home/zuse/.local/bin/grok"',
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each([
		false,
		true,
	])("upgrades retained Codex without replacing login (install failure: %s)", (failInstall) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-auth-upgrade-"));
		try {
			const authHome = join(directory, "authority");
			const bin = join(directory, "bin");
			mkdirSync(bin, { recursive: true });
			mkdirSync(authHome, { recursive: true });
			writeFileSync(
				join(authHome, "storage-incarnation-id"),
				"retained-identity",
			);
			writeFileSync(join(authHome, "saved-login"), "retained-login");
			writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.144.5\n", {
				mode: 0o755,
			});
			writeFileSync(join(bin, "grok"), "#!/bin/sh\necho grok 1.0.13\n", {
				mode: 0o755,
			});
			const count = join(directory, "installs");
			writeFileSync(
				join(bin, "npm"),
				`#!/bin/sh
printf x >> '${count}'
${
	failInstall
		? "exit 1"
		: `mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\necho codex-cli ${CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION}\\n' > "$3/node_modules/.bin/codex"
chmod +x "$3/node_modules/.bin/codex"`
}
`,
				{ mode: 0o755 },
			);
			const script = join(directory, "initialize.mjs");
			writeFileSync(script, AUTH_INITIALIZER_SOURCE);
			const run = () =>
				execFileSync(process.execPath, [script, join(directory, "done")], {
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						ZUSE_CLOUD_AUTH_HOME: authHome,
						ZUSE_AUTH_SYSTEM_GROK_BINARY: join(bin, "grok"),
						ZUSE_AUTH_MANAGED_GROK_BINARY: join(directory, "managed-grok"),
					},
				});
			run();
			expect(
				readFileSync(join(authHome, "codex-toolchain-version"), "utf8"),
			).toBe(
				`codex-cli ${failInstall ? "0.144.5" : CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION}`,
			);
			if (!failInstall) run();
			expect(readFileSync(count, "utf8")).toBe("x");
			expect(
				readFileSync(join(authHome, "storage-incarnation-id"), "utf8"),
			).toBe("retained-identity");
			expect(readFileSync(join(authHome, "saved-login"), "utf8")).toBe(
				"retained-login",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("seals a static Claude credential without exposing it to routing", () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-provider-grant-"));
		try {
			const authHome = join(directory, "authority");
			const cacheDirectory = join(authHome, "grant-cache");
			const providersDirectory = join(authHome, "providers");
			mkdirSync(cacheDirectory, { recursive: true });
			mkdirSync(providersDirectory, { recursive: true });
			writeFileSync(
				join(authHome, "storage-incarnation-id"),
				"authority-incarnation",
			);
			writeFileSync(
				join(authHome, "grant-fingerprint.key"),
				Buffer.alloc(32, 9).toString("base64url"),
			);
			const secret = "authority-only-claude-token";
			writeFileSync(
				join(providersDirectory, "claude.json"),
				JSON.stringify({
					providerId: "claude",
					method: "subscription",
					secret,
				}),
			);
			const { publicKey, privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
			});
			const scriptPath = join(directory, "provider-grant.mjs");
			const requestPath = join(directory, "request.json");
			const resultPath = join(directory, "result.json");
			const cachePath = join(cacheDirectory, "claude-request.json");
			writeFileSync(scriptPath, AUTH_GRANT_SOURCE);
			writeFileSync(
				requestPath,
				JSON.stringify({
					protocolVersion: 1,
					providerId: "claude",
					requestId: "550e8400-e29b-41d4-a716-446655440001",
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
				}),
			);
			execFileSync(
				process.execPath,
				[scriptPath, requestPath, resultPath, cachePath],
				{ env: { ...process.env, ZUSE_CLOUD_AUTH_HOME: authHome } },
			);
			const resultText = readFileSync(resultPath, "utf8");
			expect(resultText).not.toContain(secret);
			const sealed = (
				JSON.parse(resultText) as { sealed: Record<string, unknown> }
			).sealed;
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
				providerId: "claude",
				credentialKind: "oauth-token",
				secret,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refreshes native Grok auth through initialize plus authenticate", () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-grok-grant-"));
		try {
			const authHome = join(directory, "authority");
			const cacheDirectory = join(authHome, "grant-cache");
			const providersDirectory = join(authHome, "providers");
			const grokHome = join(directory, "grok-home");
			const binDirectory = join(directory, "bin");
			for (const path of [
				cacheDirectory,
				providersDirectory,
				grokHome,
				binDirectory,
			])
				mkdirSync(path, { recursive: true });
			writeFileSync(
				join(authHome, "storage-incarnation-id"),
				"authority-incarnation",
			);
			writeFileSync(
				join(authHome, "grant-fingerprint.key"),
				Buffer.alloc(32, 11).toString("base64url"),
			);
			writeFileSync(
				join(providersDirectory, "grok.json"),
				JSON.stringify({
					providerId: "grok",
					method: "subscription",
					native: true,
				}),
			);
			writeFileSync(
				join(grokHome, "auth.json"),
				JSON.stringify({
					"https://auth.x.ai::client": {
						key: "expired-access-token",
						refresh_token: "authority-only-refresh-token",
						expires_at: new Date(Date.now() - 60_000).toISOString(),
					},
				}),
			);
			writeFileSync(
				join(binDirectory, "grok"),
				`#!/usr/bin/env node
const readline = require("node:readline");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "cached_token" }] } }) + "\\n");
  if (message.id === 2) {
    writeFileSync(join(process.env.GROK_HOME, "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key: "refreshed-access-token", refresh_token: "rotated-authority-token", expires_at: new Date(Date.now() + 3600000).toISOString() } }));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) + "\\n");
  }
});
`,
				{ mode: 0o755 },
			);
			const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
			const scriptPath = join(directory, "provider-grant.mjs");
			const requestPath = join(directory, "request.json");
			const resultPath = join(directory, "result.json");
			writeFileSync(scriptPath, AUTH_GRANT_SOURCE);
			writeFileSync(
				requestPath,
				JSON.stringify({
					protocolVersion: 1,
					providerId: "grok",
					requestId: "550e8400-e29b-41d4-a716-446655440002",
					accountId: "account-1",
					workspaceId: "workspace-1",
					runtimeGeneration: 3,
					credentialPublicJwk: JSON.stringify(
						publicKey.export({ format: "jwk" }),
					),
					keyThumbprint: "runtime-key-thumbprint",
					reason: "unauthorized",
					authorityIncarnationId: "authority-incarnation",
					authorityEpoch: 4,
				}),
			);
			execFileSync(
				process.execPath,
				[
					scriptPath,
					requestPath,
					resultPath,
					join(cacheDirectory, "grok-request.json"),
				],
				{
					env: {
						...process.env,
						PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
						ZUSE_CLOUD_AUTH_HOME: authHome,
						ZUSE_GROK_AUTH_FILE: join(grokHome, "auth.json"),
						ZUSE_GROK_BINARY: join(binDirectory, "grok"),
					},
				},
			);
			const result = readFileSync(resultPath, "utf8");
			expect(result).not.toContain("refreshed-access-token");
			expect(result).not.toContain("rotated-authority-token");
			expect(JSON.parse(result)).toHaveProperty("sealed.providerId", "grok");
			expect(readFileSync(join(grokHome, "auth.json"), "utf8")).toContain(
				"rotated-authority-token",
			);
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
