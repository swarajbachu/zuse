import { generateKeyPairSync } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AccountAccessPreparedImport,
	AccountAccessSealedCredential,
	AccountAccessStatus,
	AuthSession,
	AuthUser,
	EnvironmentId,
	LocalAccountDescriptorList,
} from "@zuse/contracts";
import { Effect, Layer, Schema, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealCredentialTransfer } from "../../src/account-access/sealed-transfer.ts";
import {
	AccountAccessProcess,
	type AccountAccessProcessShape,
	AccountAccessService,
	AccountAccessServiceLive,
	accountAccessEventFromPtyChunk,
} from "../../src/account-access/service.ts";
import { AppPaths } from "../../src/app-paths.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { LanAuthService } from "../../src/lan-auth/services/lan-auth-service.ts";
import { resolveMachineRelayUrl } from "../../src/machine/machine-control-service.ts";
import { MachineRuntimeRole } from "../../src/machine/machine-runtime-role.ts";
import { makeFileCredentialsService } from "../../src/provider/layers/file-credentials-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const temporaryDirectories: string[] = [];

describe("interactive account access output", () => {
	it("forwards prompts and credentials even when the CLI does not print a newline", () => {
		expect(
			accountAccessEventFromPtyChunk("Paste code here if prompted > "),
		).toEqual({
			_tag: "line",
			text: "Paste code here if prompted > ",
		});
		expect(accountAccessEventFromPtyChunk("")).toBeNull();
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

const makeIdentity = () => {
	const identity = generateKeyPairSync("ed25519");
	return {
		privateJwk: JSON.stringify(identity.privateKey.export({ format: "jwk" })),
		publicJwk: JSON.stringify(identity.publicKey.export({ format: "jwk" })),
	};
};

const makeLayer = (
	userData: string,
	processOverrides: Partial<AccountAccessProcessShape> = {},
	options: {
		readonly role?: "control-plane" | "cloud-environment";
		readonly signedInUserId?: string;
		readonly accessToken?: string;
		readonly identity?: ReturnType<typeof makeIdentity>;
		readonly relayConfig?: "available" | "missing";
		readonly relayUrl?: string;
	} = {},
) => {
	const processRunner: AccountAccessProcessShape = {
		capture: () =>
			Effect.succeed({
				stdout: "Claude Code 2.1.224",
				stderr: "",
				code: 0,
			}),
		stream: () => Stream.empty,
		write: () => Effect.void,
		cancel: () => Effect.void,
		...processOverrides,
	};
	const environmentId = EnvironmentId.make("01JZUSE0000000000000000000");
	const identity = options.identity ?? makeIdentity();
	const { privateJwk, publicJwk } = identity;
	const credentialsLayer = makeFileCredentialsService(userData);
	return AccountAccessServiceLive.pipe(
		Layer.provide(credentialsLayer),
		Layer.provide(Layer.succeed(AppPaths, { userData })),
		Layer.provide(
			Layer.succeed(MachineRuntimeRole, options.role ?? "cloud-environment"),
		),
		Layer.provide(
			Layer.succeed(
				AuthService,
				AuthService.of({
					getSession: () =>
						Effect.succeed(
							options.signedInUserId === undefined
								? ({ _tag: "SignedOut" } as const)
								: ({
										_tag: "SignedIn",
										session: AuthSession.make({
											user: AuthUser.make({
												id: options.signedInUserId,
												email: "person@example.com",
												firstName: null,
												lastName: null,
												profilePictureUrl: null,
											}),
											organizationId: null,
											expiresAt: Date.now() + 60_000,
										}),
									} as const),
						),
					signIn: () => Effect.die("unused"),
					signOut: () => Effect.void,
					sessionChanges: () => Stream.empty,
					getAccessToken: () =>
						Effect.succeed(options.accessToken ?? "test-token"),
				}),
			),
		),
		Layer.provide(
			Layer.succeed(LanAuthService, {
				environmentId: () => Effect.succeed(environmentId),
				environmentKeys: () =>
					Effect.succeed({
						environmentId,
						envId: environmentId,
						privateJwk,
						publicJwk,
					}),
				getRelayConfig: () =>
					Effect.succeed(
						options.relayConfig === "missing"
							? null
							: {
									relayUrl: options.relayUrl ?? "https://relay.staging.example",
									relayIssuer:
										options.relayUrl ?? "https://relay.staging.example",
									environmentId,
									environmentCredential: "unused-in-test",
									label: undefined,
									connectorToken: undefined,
									tunnelHostname: undefined,
									mintPublicKey: undefined,
								},
					),
			} as unknown as LanAuthService["Service"]),
		),
		Layer.provide(
			Layer.succeed(
				AccountAccessProcess,
				AccountAccessProcess.of(processRunner),
			),
		),
		Layer.merge(credentialsLayer),
	);
};

describe("AccountAccessService", () => {
	it("exports an authenticated local GitHub account for one-click cloud import", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-export-"));
		temporaryDirectories.push(userData);
		const credential = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				return yield* service.exportLocalCredential("github");
			}).pipe(
				Effect.provide(
					makeLayer(
						userData,
						{
							capture: (command, args) =>
								command === "gh" && args[0] === "auth" && args[1] === "token"
									? Effect.succeed({
											stdout: "github-test-token\n",
											stderr: "",
											code: 0,
										})
									: Effect.succeed({ stdout: "", stderr: "", code: 1 }),
						},
						{ role: "control-plane" },
					),
				),
			),
		);

		expect(credential).toMatchObject({
			providerId: "github",
			credentialType: "repository-token",
			secret: "github-test-token",
		});
	});

	it("returns wire-encodable account status and transfer values", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-wire-"));
		temporaryDirectories.push(userData);
		const cloudLayer = makeLayer(userData);
		const { prepared, sealed, status } = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				const status = yield* service.status();
				const prepared = yield* service.prepareImport({
					accountId: "user_01JZUSE0000000000000000000",
					providerId: "claude",
				});
				const sealed = sealCredentialTransfer(prepared, {
					providerId: "claude",
					kind: "oauth-token",
					secret: "remote-oauth-token",
				});
				return { prepared, sealed, status };
			}).pipe(Effect.provide(cloudLayer)),
		);
		const local = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				return yield* service.detectLocal();
			}).pipe(
				Effect.provide(makeLayer(userData, {}, { role: "control-plane" })),
			),
		);

		expect(() => Schema.encodeSync(AccountAccessStatus)(status)).not.toThrow();
		expect(() =>
			Schema.encodeSync(LocalAccountDescriptorList)(local),
		).not.toThrow();
		expect(() =>
			Schema.encodeSync(AccountAccessPreparedImport)(prepared),
		).not.toThrow();
		expect(() =>
			Schema.encodeSync(AccountAccessSealedCredential)(sealed),
		).not.toThrow();
	});

	it("imports a prepared Claude credential exactly once", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-access-"));
		temporaryDirectories.push(userData);
		const layer = makeLayer(userData);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				const prepared = yield* service.prepareImport({
					accountId: "user_01JZUSE0000000000000000000",
					providerId: "claude",
				});
				const sealed = sealCredentialTransfer(prepared, {
					providerId: "claude",
					kind: "oauth-token",
					secret: "remote-oauth-token",
				});
				const imported = yield* service.importCredential({
					transferId: prepared.transferId,
					sealed,
				});
				const credentials = yield* CredentialsService;
				const stored = yield* credentials.getProviderCredential("claude");
				const replay = yield* Effect.flip(
					service.importCredential({
						transferId: prepared.transferId,
						sealed,
					}),
				);
				return { imported, stored, replay };
			}).pipe(Effect.provide(layer)),
		);

		expect(result.imported).toMatchObject({
			providerId: "claude",
			state: "connected",
			authKind: "oauth-token",
		});
		expect(result.stored).toMatchObject({
			kind: "oauth-token",
			secret: "remote-oauth-token",
		});
		expect(result.replay.code).toBe("transfer-replayed");
	});

	it("removes only known credential paths before requesting runtime stop", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-cleanup-"));
		temporaryDirectories.push(userData);
		const accountHome = join(userData, "home");
		const credentialPaths = [
			join(userData, "secrets", "credentials.json"),
			join(accountHome, ".config", "gh", "hosts.yml"),
			join(accountHome, ".codex", "auth.json"),
			join(accountHome, ".claude", ".credentials.json"),
		];
		const unrelated = join(accountHome, ".claude", "settings.json");
		for (const path of [...credentialPaths, unrelated]) {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, "secret", { mode: 0o600 });
		}
		const previousHome = process.env.ZUSE_ACCOUNT_ACCESS_HOME;
		process.env.ZUSE_ACCOUNT_ACCESS_HOME = accountHome;
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* AccountAccessService;
					yield* service.sanitizeCredentials();
					yield* service.requestRuntimeStop();
				}).pipe(Effect.provide(makeLayer(userData))),
			);
		} finally {
			if (previousHome === undefined)
				delete process.env.ZUSE_ACCOUNT_ACCESS_HOME;
			else process.env.ZUSE_ACCOUNT_ACCESS_HOME = previousHome;
		}

		for (const path of credentialPaths) {
			await expect(access(path)).rejects.toThrow();
		}
		expect(await readFile(unrelated, "utf8")).toBe("secret");
		const marker = join(userData, "credential-cleanup-ready");
		expect((await stat(marker)).mode & 0o777).toBe(0o600);
	});

	it("hardens native GitHub and Codex credential stores after login", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-native-"));
		temporaryDirectories.push(userData);
		const accountHome = join(userData, "home");
		const githubDirectory = join(accountHome, ".config", "gh");
		const codexDirectory = join(accountHome, ".codex");
		const loginEnvironments: Array<
			Readonly<Record<string, string>> | undefined
		> = [];
		const githubFile = join(githubDirectory, "hosts.yml");
		const codexFile = join(codexDirectory, "auth.json");
		for (const [directory, file] of [
			[githubDirectory, githubFile],
			[codexDirectory, codexFile],
		] as const) {
			await mkdir(directory, { recursive: true, mode: 0o755 });
			await writeFile(file, "credential", { mode: 0o644 });
		}
		const previousHome = process.env.ZUSE_ACCOUNT_ACCESS_HOME;
		process.env.ZUSE_ACCOUNT_ACCESS_HOME = accountHome;
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* AccountAccessService;
					yield* Stream.runDrain(service.startLogin("github"));
					yield* Stream.runDrain(service.startLogin("codex"));
				}).pipe(
					Effect.provide(
						makeLayer(userData, {
							capture: () =>
								Effect.succeed({ stdout: "account", stderr: "", code: 0 }),
							stream: (_command, _args, environment) => {
								loginEnvironments.push(environment);
								return Stream.make({ _tag: "exit", code: 0 });
							},
						}),
					),
				),
			);
		} finally {
			if (previousHome === undefined)
				delete process.env.ZUSE_ACCOUNT_ACCESS_HOME;
			else process.env.ZUSE_ACCOUNT_ACCESS_HOME = previousHome;
		}

		for (const directory of [githubDirectory, codexDirectory]) {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
		}
		for (const file of [githubFile, codexFile]) {
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
		expect(loginEnvironments).toEqual([{ GH_PROMPT_DISABLED: "1" }, undefined]);
	});

	it("keeps GitHub's device code until its later verification URL", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-device-code-"));
		temporaryDirectories.push(userData);
		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				const collected = yield* Stream.runCollect(
					service.startLogin("github"),
				);
				return collected;
			}).pipe(
				Effect.provide(
					makeLayer(userData, {
						capture: () =>
							Effect.succeed({ stdout: "account", stderr: "", code: 0 }),
						stream: () =>
							Stream.make(
								{ _tag: "line", text: "Copy your one-time code: ABCD-EFGH" },
								{ _tag: "line", text: "Open https://github.com/login/device" },
							),
					}),
				),
			),
		);

		expect([...events]).toContainEqual({
			_tag: "verification",
			url: "https://github.com/login/device",
			code: "ABCD-EFGH",
		});
	});

	it("waits for Codex's code when the verification URL arrives first", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-codex-code-"));
		temporaryDirectories.push(userData);
		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				return yield* Stream.runCollect(service.startLogin("codex"));
			}).pipe(
				Effect.provide(
					makeLayer(userData, {
						stream: () =>
							Stream.make(
								{
									_tag: "line",
									text: "Open https://auth.openai.com/codex/device",
								},
								{ _tag: "line", text: "Enter code WXYZ-12345" },
							),
					}),
				),
			),
		);

		expect([...events]).toContainEqual({
			_tag: "verification",
			url: "https://auth.openai.com/codex/device",
			code: "WXYZ-12345",
		});
	});

	it("starts a Claude transfer without a local relay registration", async () => {
		const userData = await mkdtemp(
			join(tmpdir(), "zuse-account-claude-relay-"),
		);
		temporaryDirectories.push(userData);
		const accountId = "user_01JZUSE0000000000000000000";
		const relayUrl = resolveMachineRelayUrl();
		const identity = makeIdentity();
		const prepared = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				return yield* service.prepareImport({
					accountId,
					providerId: "claude",
				});
			}).pipe(Effect.provide(makeLayer(userData, {}, { identity, relayUrl }))),
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					environments: [
						{
							environmentId: prepared.environmentId,
							providerKind: "cloud",
							linkedAt: Date.now(),
							environmentPublicKey: identity.publicJwk,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				return yield* Stream.runCollect(
					service.createClaudeTransfer({ prepared }),
				);
			}).pipe(
				Effect.provide(
					makeLayer(
						userData,
						{
							stream: () =>
								Stream.make(
									{
										_tag: "line",
										text: "Open https://claude.ai/setup-token\r\nPaste code here if prompted > ",
									},
									{
										_tag: "line",
										text: "Token: sk-ant-oat01-abcdefghijklmnopqrstuvwxyz123456\u001b[39m",
									},
								),
						},
						{
							role: "control-plane",
							signedInUserId: accountId,
							identity,
							relayConfig: "missing",
							relayUrl,
						},
					),
				),
			),
		);

		expect([...events]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ _tag: "verification" }),
				{ _tag: "input-ready" },
				expect.objectContaining({ _tag: "sealed" }),
				{ _tag: "done", ok: true },
			]),
		);
	});

	it("continues and cancels an interactive Claude login without exposing the code in arguments", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-account-continue-"));
		temporaryDirectories.push(userData);
		const writes: Array<{
			readonly sessionId: string;
			readonly input: string;
		}> = [];
		const cancellations: string[] = [];
		const layer = makeLayer(
			userData,
			{
				write: (sessionId, input) =>
					Effect.sync(() => writes.push({ sessionId, input })),
				cancel: (sessionId) => Effect.sync(() => cancellations.push(sessionId)),
			},
			{
				role: "control-plane",
				signedInUserId: "user_01JZUSE0000000000000000000",
			},
		);

		const invalid = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* AccountAccessService;
				yield* service.continueClaudeTransfer({
					_tag: "code",
					transferId: "transfer-1",
					code: "safe-auth-code",
				});
				const rejected = yield* Effect.flip(
					service.continueClaudeTransfer({
						_tag: "code",
						transferId: "transfer-1",
						code: "unsafe\ncode",
					}),
				);
				yield* service.continueClaudeTransfer({
					_tag: "cancel",
					transferId: "transfer-2",
				});
				return rejected;
			}).pipe(Effect.provide(layer)),
		);

		expect(writes).toEqual([
			{ sessionId: "transfer-1", input: "safe-auth-code\r" },
		]);
		expect(cancellations).toEqual(["transfer-2"]);
		expect(invalid.code).toBe("transfer-rejected");
	});
});
