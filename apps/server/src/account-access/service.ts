import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { scrubInheritedClaudeMarkers } from "@zuse/agents/drivers/claude-env";
import type {
	AccountAccessClaudeTransferContinuation,
	AccountAccessCreateClaudeTransferRequest,
	AccountAccessImportRequest,
	AccountAccessPreparedImport,
	AccountAccessProvider,
	AccountAccessTransferEvent,
} from "@zuse/contracts";
import {
	AccountAccessProviderStatus,
	AccountAccessStatus,
	LocalAccountDescriptor,
	LocalAccountDescriptorList,
	RelayEnvironmentList,
	RelayPaths,
} from "@zuse/contracts";
import {
	Cause,
	Context,
	Effect,
	Layer,
	Queue,
	Ref,
	Schema,
	Stream,
} from "effect";
import * as pty from "node-pty";

import { AppPaths } from "../app-paths.ts";
import { AuthService } from "../auth/services/auth-service.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { resolveMachineRelayUrl } from "../machine/machine-control-service.ts";
import { MachineRuntimeRole } from "../machine/machine-runtime-role.ts";
import { CredentialsService } from "../provider/services/credentials-service.ts";
import { ensureNodePtySpawnHelperExecutable } from "../pty/node-pty-helper.ts";
import {
	extractClaudeSetupToken,
	getAccountAccessLoginCommand,
	parseClaudeSetupVerification,
	parseDeviceLoginVerification,
	redactAccountAccessOutput,
} from "./adapters.ts";
import { AccountAccessServiceError } from "./errors.ts";
import {
	openCredentialTransfer,
	type PreparedCredentialTransfer,
	prepareCredentialTransfer,
	publicPreparedImport,
	sealCredentialTransfer,
	signPreparedImport,
	verifyPreparedImport,
} from "./sealed-transfer.ts";

const execFileAsync = promisify(execFile);
const TRANSFER_TTL_MS = 5 * 60 * 1_000;

export type AccountAccessProcessEvent =
	| { readonly _tag: "line"; readonly text: string }
	| { readonly _tag: "exit"; readonly code: number };

export interface AccountAccessProcessShape {
	readonly capture: (
		command: string,
		args: ReadonlyArray<string>,
	) => Effect.Effect<
		{ readonly stdout: string; readonly stderr: string; readonly code: number },
		AccountAccessServiceError
	>;
	readonly stream: (
		command: string,
		args: ReadonlyArray<string>,
		environment?: Readonly<Record<string, string>>,
		sessionId?: string,
	) => Stream.Stream<AccountAccessProcessEvent, AccountAccessServiceError>;
	readonly write: (
		sessionId: string,
		input: string,
	) => Effect.Effect<void, AccountAccessServiceError>;
	readonly cancel: (
		sessionId: string,
	) => Effect.Effect<void, AccountAccessServiceError>;
}

export class AccountAccessProcess extends Context.Service<
	AccountAccessProcess,
	AccountAccessProcessShape
>()("zuse/AccountAccessProcess") {}

const captureProcess: AccountAccessProcessShape["capture"] = (command, args) =>
	Effect.tryPromise({
		try: async () => {
			try {
				const result = await execFileAsync(command, [...args], {
					cwd: homedir(),
					env: process.env,
					timeout: 30_000,
					maxBuffer: 256 * 1_024,
				});
				return { stdout: result.stdout, stderr: result.stderr, code: 0 };
			} catch (cause) {
				const failure = cause as {
					stdout?: string;
					stderr?: string;
					code?: number | string;
				};
				if (typeof failure.code === "number") {
					return {
						stdout: failure.stdout ?? "",
						stderr: failure.stderr ?? "",
						code: failure.code,
					};
				}
				throw cause;
			}
		},
		catch: () => new AccountAccessServiceError("tool-not-installed"),
	});

const processEnvironment = (
	overrides: Readonly<Record<string, string>> | undefined,
): Record<string, string> => ({
	...Object.fromEntries(
		Object.entries(scrubInheritedClaudeMarkers(process.env)).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	),
	...overrides,
});

const interactiveProcesses = new Map<string, pty.IPty>();

export const accountAccessEventFromPtyChunk = (
	chunk: string,
): AccountAccessProcessEvent | null =>
	chunk.length === 0 ? null : { _tag: "line", text: chunk };

const streamPtyProcess: AccountAccessProcessShape["stream"] = (
	command,
	args,
	environment,
	sessionId,
) =>
	Stream.callback<AccountAccessProcessEvent, AccountAccessServiceError>(
		(queue) =>
			Effect.gen(function* () {
				if (sessionId === undefined || interactiveProcesses.has(sessionId)) {
					return yield* Effect.fail(
						new AccountAccessServiceError("login-failed"),
					);
				}
				ensureNodePtySpawnHelperExecutable();
				const child = pty.spawn(command, [...args], {
					name: "xterm-256color",
					cols: 100,
					rows: 24,
					cwd: homedir(),
					env: processEnvironment(environment),
				});
				interactiveProcesses.set(sessionId, child);
				const data = child.onData((chunk) => {
					const event = accountAccessEventFromPtyChunk(chunk);
					if (event !== null) Queue.offerUnsafe(queue, event);
				});
				const exit = child.onExit(({ exitCode }) => {
					if (interactiveProcesses.get(sessionId) === child) {
						interactiveProcesses.delete(sessionId);
					}
					Queue.offerUnsafe(queue, { _tag: "exit", code: exitCode });
					Queue.endUnsafe(queue);
				});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						data.dispose();
						exit.dispose();
						if (interactiveProcesses.get(sessionId) === child) {
							interactiveProcesses.delete(sessionId);
						}
						try {
							child.kill();
						} catch {
							// The PTY may already have exited.
						}
					}),
				);
			}),
	);

const streamProcess: AccountAccessProcessShape["stream"] = (
	command,
	args,
	environment,
	sessionId,
) =>
	command === "claude" && args[0] === "setup-token"
		? streamPtyProcess(command, args, environment, sessionId)
		: Stream.callback<AccountAccessProcessEvent, AccountAccessServiceError>(
				(queue) =>
					Effect.gen(function* () {
						const child = spawn(command, [...args], {
							cwd: homedir(),
							env: processEnvironment(environment),
							stdio: ["ignore", "pipe", "pipe"],
						});
						let completed = false;
						const emit = (chunk: Buffer | string): void => {
							for (const text of chunk.toString().split(/\r?\n/u)) {
								if (text.trim().length > 0) {
									Queue.offerUnsafe(queue, { _tag: "line", text });
								}
							}
						};
						child.stdout.on("data", emit);
						child.stderr.on("data", emit);
						child.once("error", () => {
							completed = true;
							Queue.failCauseUnsafe(
								queue,
								Cause.fail(new AccountAccessServiceError("tool-not-installed")),
							);
						});
						child.once("exit", (code) => {
							completed = true;
							Queue.offerUnsafe(queue, { _tag: "exit", code: code ?? 1 });
							Queue.endUnsafe(queue);
						});
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								if (!completed) child.kill("SIGTERM");
							}),
						);
					}),
			);

const writeProcess: AccountAccessProcessShape["write"] = (sessionId, input) =>
	Effect.try({
		try: () => {
			const child = interactiveProcesses.get(sessionId);
			if (child === undefined) throw new Error("session_not_found");
			child.write(input);
		},
		catch: () => new AccountAccessServiceError("login-failed"),
	});

const cancelProcess: AccountAccessProcessShape["cancel"] = (sessionId) =>
	Effect.try({
		try: () => {
			const child = interactiveProcesses.get(sessionId);
			if (child === undefined) throw new Error("session_not_found");
			child.kill();
		},
		catch: () => new AccountAccessServiceError("login-failed"),
	});

export const AccountAccessProcessLive = Layer.succeed(
	AccountAccessProcess,
	AccountAccessProcess.of({
		capture: captureProcess,
		stream: streamProcess,
		write: writeProcess,
		cancel: cancelProcess,
	}),
);

export interface AccountAccessServiceShape {
	readonly status: () => Effect.Effect<
		AccountAccessStatus,
		AccountAccessServiceError
	>;
	readonly detectLocal: () => Effect.Effect<
		LocalAccountDescriptorList,
		AccountAccessServiceError
	>;
	readonly startLogin: (
		providerId: "github" | "codex",
	) => Stream.Stream<AccountAccessTransferEvent, AccountAccessServiceError>;
	readonly prepareImport: (input: {
		readonly accountId: string;
		readonly providerId: "claude";
	}) => Effect.Effect<AccountAccessPreparedImport, AccountAccessServiceError>;
	readonly createClaudeTransfer: (
		request: AccountAccessCreateClaudeTransferRequest,
	) => Stream.Stream<AccountAccessTransferEvent, AccountAccessServiceError>;
	readonly continueClaudeTransfer: (
		request: AccountAccessClaudeTransferContinuation,
	) => Effect.Effect<void, AccountAccessServiceError>;
	readonly importCredential: (
		request: AccountAccessImportRequest,
	) => Effect.Effect<AccountAccessProviderStatus, AccountAccessServiceError>;
	readonly disconnect: (
		providerId: AccountAccessProvider,
	) => Effect.Effect<AccountAccessProviderStatus, AccountAccessServiceError>;
	readonly sanitizeCredentials: () => Effect.Effect<
		void,
		AccountAccessServiceError
	>;
	readonly requestRuntimeStop: () => Effect.Effect<
		void,
		AccountAccessServiceError
	>;
}

export class AccountAccessService extends Context.Service<
	AccountAccessService,
	AccountAccessServiceShape
>()("zuse/AccountAccessService") {}

const emptyStatus = (
	providerId: AccountAccessProvider,
	installed: boolean,
): AccountAccessProviderStatus =>
	new AccountAccessProviderStatus({
		providerId,
		state: installed ? "disconnected" : "missing-tool",
		installed,
	});

export const AccountAccessServiceLive = Layer.effect(
	AccountAccessService,
	Effect.gen(function* () {
		const processRunner = yield* AccountAccessProcess;
		const auth = yield* AuthService;
		const lanAuth = yield* LanAuthService;
		const credentials = yield* CredentialsService;
		const role = yield* MachineRuntimeRole;
		const paths = yield* AppPaths;
		const preparedTransfers = yield* Ref.make(
			new Map<string, PreparedCredentialTransfer>(),
		);

		const requireRole = (expected: typeof role) =>
			role === expected
				? Effect.void
				: Effect.fail(new AccountAccessServiceError("not-allowed"));

		const capture = (command: string, args: ReadonlyArray<string>) =>
			processRunner.capture(command, args);

		const commandInstalled = (command: string, versionArgs = ["--version"]) =>
			capture(command, versionArgs).pipe(
				Effect.map((result) => result.code === 0),
				Effect.orElseSucceed(() => false),
			);
		const nativeCredentialPath = (providerId: "github" | "codex") => {
			const accountHome =
				process.env.ZUSE_ACCOUNT_ACCESS_HOME?.trim() || homedir();
			return providerId === "github"
				? join(accountHome, ".config", "gh", "hosts.yml")
				: join(accountHome, ".codex", "auth.json");
		};

		const hardenNativeCredentialStore = (providerId: "github" | "codex") =>
			Effect.tryPromise({
				try: async () => {
					const file = nativeCredentialPath(providerId);
					const directory = dirname(file);
					await chmod(directory, 0o700);
					await chmod(file, 0o600);
				},
				catch: () => new AccountAccessServiceError("credential-store-failed"),
			});

		const providerStatus = Effect.fn("AccountAccess.providerStatus")(function* (
			providerId: AccountAccessProvider,
		) {
			const installed = yield* commandInstalled(
				providerId === "github" ? "gh" : providerId,
			);
			if (!installed) return emptyStatus(providerId, false);

			if (providerId === "claude") {
				const credential = yield* credentials
					.getProviderCredential("claude")
					.pipe(
						Effect.mapError(
							() => new AccountAccessServiceError("credential-store-failed"),
						),
					);
				return credential === null
					? emptyStatus("claude", true)
					: new AccountAccessProviderStatus({
							providerId: "claude" as const,
							state: "connected" as const,
							installed: true,
							authKind: credential.kind,
							lastSyncedAt: credential.updatedAt,
						});
			}

			const result =
				providerId === "github"
					? yield* capture("gh", ["api", "user", "--jq", ".login"]).pipe(
							Effect.orElseSucceed(() => ({
								stdout: "",
								stderr: "",
								code: 1,
							})),
						)
					: yield* capture("codex", ["login", "status"]).pipe(
							Effect.orElseSucceed(() => ({
								stdout: "",
								stderr: "",
								code: 1,
							})),
						);
			if (result.code !== 0) return emptyStatus(providerId, true);
			const safeLabel =
				providerId === "github"
					? result.stdout.trim().slice(0, 120)
					: "OpenAI account";
			const lastSyncedAt = yield* Effect.tryPromise({
				try: async () => (await stat(nativeCredentialPath(providerId))).mtimeMs,
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined));
			return new AccountAccessProviderStatus({
				providerId,
				state: "connected" as const,
				installed: true,
				accountLabel: safeLabel || undefined,
				authKind: "device" as const,
				...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
			});
		});

		const status = Effect.fn("AccountAccess.status")(function* () {
			yield* requireRole("cloud-environment");
			const providers = yield* Effect.all(
				(["github", "claude", "codex"] as const).map(providerStatus),
				{ concurrency: 3 },
			);
			return new AccountAccessStatus({ providers });
		});

		const detectLocal = Effect.fn("AccountAccess.detectLocal")(function* () {
			yield* requireRole("control-plane");
			const providers = ["github", "claude", "codex"] as const;
			const accounts = yield* Effect.all(
				providers.map((providerId) =>
					Effect.gen(function* () {
						const installed = yield* commandInstalled(
							providerId === "github" ? "gh" : providerId,
						);
						let accountLabel: string | undefined;
						let detected = false;
						if (installed && providerId === "github") {
							const result = yield* capture("gh", [
								"api",
								"user",
								"--jq",
								".login",
							]).pipe(Effect.orElseSucceed(() => null));
							detected = result?.code === 0;
							accountLabel = detected
								? result?.stdout.trim().slice(0, 120)
								: undefined;
						} else if (installed) {
							const result = yield* capture(providerId, [
								...(providerId === "codex" ? ["login"] : ["auth"]),
								"status",
							]).pipe(Effect.orElseSucceed(() => null));
							detected = result?.code === 0;
							accountLabel = detected
								? providerId === "claude"
									? "Claude account"
									: "OpenAI account"
								: undefined;
						}
						return new LocalAccountDescriptor({
							providerId,
							installed,
							detected,
							...(accountLabel !== undefined ? { accountLabel } : {}),
							action:
								providerId === "claude" ? "sealed-transfer" : "device-login",
						});
					}),
				),
				{ concurrency: 3 },
			);
			return new LocalAccountDescriptorList({ accounts });
		});

		const prepareImport = Effect.fn("AccountAccess.prepareImport")(
			function* (input: {
				readonly accountId: string;
				readonly providerId: "claude";
			}) {
				yield* requireRole("cloud-environment");
				const environmentId = yield* lanAuth
					.environmentId()
					.pipe(
						Effect.mapError(
							() => new AccountAccessServiceError("transfer-rejected"),
						),
					);
				const transferId = crypto.randomUUID();
				const prepared = prepareCredentialTransfer({
					accountId: input.accountId,
					environmentId,
					transferId,
					expiresAt: Date.now() + TRANSFER_TTL_MS,
				});
				const [keys, relayConfig] = yield* Effect.all([
					lanAuth.environmentKeys(),
					lanAuth.getRelayConfig(),
				]).pipe(
					Effect.mapError(
						() => new AccountAccessServiceError("transfer-rejected"),
					),
				);
				if (
					relayConfig === null ||
					keys.envId !== environmentId ||
					relayConfig.environmentId !== environmentId
				) {
					return yield* Effect.fail(
						new AccountAccessServiceError("transfer-rejected"),
					);
				}
				const environmentProof = yield* Effect.tryPromise({
					try: () =>
						signPreparedImport(
							prepared,
							keys.privateJwk,
							relayConfig.relayIssuer,
						),
					catch: () => new AccountAccessServiceError("transfer-rejected"),
				});
				yield* Ref.update(preparedTransfers, (current) => {
					const next = new Map(
						[...current].filter(([, value]) => value.expiresAt > Date.now()),
					);
					next.set(transferId, prepared);
					return next;
				});
				return publicPreparedImport(prepared, environmentProof);
			},
		);

		const startLogin = (
			providerId: "github" | "codex",
		): Stream.Stream<AccountAccessTransferEvent, AccountAccessServiceError> => {
			if (role !== "cloud-environment") {
				return Stream.fail(new AccountAccessServiceError("not-allowed"));
			}
			const command = getAccountAccessLoginCommand(providerId);
			let verificationEmitted = false;
			let pendingVerificationCode: string | undefined;
			let pendingVerificationUrl: string | undefined;
			const loginEvents = processRunner.stream(
				command.command,
				command.args,
				command.environment,
			);
			return loginEvents.pipe(
				Stream.flatMap(
					(
						event,
					): Stream.Stream<
						AccountAccessTransferEvent,
						AccountAccessServiceError
					> => {
						if (event._tag === "exit") {
							if (event.code !== 0) {
								return Stream.succeed({
									_tag: "done",
									ok: false,
									reason: "login-failed",
								});
							}
							return Stream.fromEffect(
								Effect.gen(function* () {
									if (providerId === "github") {
										const configured = yield* capture("gh", [
											"auth",
											"setup-git",
										]);
										if (configured.code !== 0) {
											return yield* Effect.fail(
												new AccountAccessServiceError("login-failed"),
											);
										}
										const privateAccess = yield* capture("gh", [
											"api",
											"user/repos?visibility=private&per_page=1",
											"--jq",
											"length",
										]);
										if (privateAccess.code !== 0) {
											return yield* Effect.fail(
												new AccountAccessServiceError("login-failed"),
											);
										}
									}
									yield* hardenNativeCredentialStore(providerId);
									return {
										_tag: "done" as const,
										ok: true,
									};
								}),
							);
						}
						const safe = redactAccountAccessOutput(event.text).slice(0, 500);
						const verification = parseDeviceLoginVerification(providerId, safe);
						pendingVerificationCode ??= verification.code;
						pendingVerificationUrl ??= verification.url;
						if (
							!verificationEmitted &&
							pendingVerificationUrl !== undefined &&
							pendingVerificationCode !== undefined
						) {
							verificationEmitted = true;
							return Stream.succeed({
								_tag: "verification",
								url: pendingVerificationUrl,
								code: pendingVerificationCode,
							});
						}
						return Stream.succeed({
							_tag: "progress",
							message: "Waiting for authorization…",
						});
					},
				),
			);
		};

		const createClaudeTransfer = (
			request: AccountAccessCreateClaudeTransferRequest,
		): Stream.Stream<AccountAccessTransferEvent, AccountAccessServiceError> => {
			if (role !== "control-plane") {
				return Stream.fail(new AccountAccessServiceError("not-allowed"));
			}
			return Stream.unwrap(
				Effect.gen(function* () {
					const session = yield* auth.getSession();
					if (
						session._tag !== "SignedIn" ||
						session.session.user.id !== request.prepared.accountId
					) {
						return Stream.fail(new AccountAccessServiceError("not-signed-in"));
					}
					const relayUrl = resolveMachineRelayUrl();
					const accessToken = yield* auth
						.getAccessToken()
						.pipe(
							Effect.mapError(
								() => new AccountAccessServiceError("not-signed-in"),
							),
						);
					const environments = yield* Effect.tryPromise({
						try: async () => {
							const response = await fetch(
								`${relayUrl}${RelayPaths.environments}`,
								{
									headers: { authorization: `Bearer ${accessToken}` },
									signal: AbortSignal.timeout(10_000),
								},
							);
							if (!response.ok) throw new Error("relay_rejected");
							return Schema.decodeUnknownSync(RelayEnvironmentList)(
								await response.json(),
							);
						},
						catch: () => new AccountAccessServiceError("transfer-rejected"),
					});
					const destination = environments.environments.find(
						(environment) =>
							environment.environmentId === request.prepared.environmentId,
					);
					if (destination?.environmentPublicKey === undefined) {
						return Stream.fail(
							new AccountAccessServiceError("transfer-rejected"),
						);
					}
					const environmentPublicKey = destination.environmentPublicKey;
					yield* Effect.tryPromise({
						try: () =>
							verifyPreparedImport(
								request.prepared,
								environmentPublicKey,
								relayUrl,
							),
						catch: () => new AccountAccessServiceError("transfer-rejected"),
					});
					let token: string | null = null;
					let verificationEmitted = false;
					let setupTranscript = "";
					return processRunner
						.stream(
							"claude",
							["setup-token"],
							undefined,
							request.prepared.transferId,
						)
						.pipe(
							Stream.flatMap((event) => {
								if (event._tag === "line") {
									setupTranscript = `${setupTranscript}${event.text}`.slice(
										-32_768,
									);
									token ??= extractClaudeSetupToken(setupTranscript);
									if (token !== null) {
										const sealed = sealCredentialTransfer(request.prepared, {
											providerId: "claude",
											kind: "oauth-token",
											secret: token,
										});
										return Stream.fromIterable<AccountAccessTransferEvent>([
											{ _tag: "sealed", sealed },
											{ _tag: "done", ok: true },
										]);
									}
									const safeTranscript =
										redactAccountAccessOutput(setupTranscript);
									if (
										/Invalid code|Failed to exchange authorization code/iu.test(
											safeTranscript,
										)
									) {
										return Stream.succeed<AccountAccessTransferEvent>({
											_tag: "done",
											ok: false,
											reason: "login-failed",
										});
									}
									const verification =
										parseClaudeSetupVerification(setupTranscript);
									if (!verificationEmitted && verification.url !== undefined) {
										verificationEmitted = true;
										return Stream.succeed<AccountAccessTransferEvent>({
											_tag: "verification",
											url: verification.url,
											...(verification.code === undefined
												? {}
												: { code: verification.code }),
										});
									}
									return Stream.succeed<AccountAccessTransferEvent>({
										_tag: "progress",
										message: "Waiting for Claude authorization…",
									});
								}
								if (event.code !== 0) {
									return Stream.succeed<AccountAccessTransferEvent>({
										_tag: "done",
										ok: false,
										reason: "login-failed",
									});
								}
								return Stream.succeed<AccountAccessTransferEvent>({
									_tag: "done",
									ok: false,
									reason: "login-failed",
								});
							}),
							Stream.takeUntil((event) => event._tag === "done"),
						);
				}),
			);
		};

		const continueClaudeTransfer = Effect.fn(
			"AccountAccess.continueClaudeTransfer",
		)(function* (request: AccountAccessClaudeTransferContinuation) {
			yield* requireRole("control-plane");
			const session = yield* auth.getSession();
			if (session._tag !== "SignedIn") {
				return yield* Effect.fail(
					new AccountAccessServiceError("not-signed-in"),
				);
			}
			if (request._tag === "cancel") {
				yield* processRunner.cancel(request.transferId);
				return;
			}
			const code = request.code.trim();
			const containsControlCharacter = [...code].some((character) => {
				const value = character.charCodeAt(0);
				return value < 32 || value === 127;
			});
			if (
				code.length === 0 ||
				code.length > 4_096 ||
				containsControlCharacter
			) {
				return yield* Effect.fail(
					new AccountAccessServiceError("transfer-rejected"),
				);
			}
			yield* processRunner.write(request.transferId, `${code}\r`);
		});

		const importCredential = Effect.fn("AccountAccess.importCredential")(
			function* (request: AccountAccessImportRequest) {
				yield* requireRole("cloud-environment");
				const entry = yield* Ref.modify(preparedTransfers, (current) => {
					const found = current.get(request.transferId);
					if (found === undefined) return [found, current];
					const next = new Map(current);
					next.delete(request.transferId);
					return [found, next];
				});
				if (entry === undefined) {
					return yield* Effect.fail(
						new AccountAccessServiceError("transfer-replayed"),
					);
				}
				if (Date.now() > entry.expiresAt) {
					return yield* Effect.fail(
						new AccountAccessServiceError("transfer-expired"),
					);
				}
				let payload: ReturnType<typeof openCredentialTransfer>;
				try {
					payload = openCredentialTransfer(entry, request.sealed, Date.now());
				} catch {
					return yield* Effect.fail(
						new AccountAccessServiceError("transfer-rejected"),
					);
				}
				yield* credentials
					.setProviderCredential("claude", {
						kind: payload.kind,
						secret: payload.secret,
					})
					.pipe(
						Effect.mapError(
							() => new AccountAccessServiceError("credential-store-failed"),
						),
					);
				return yield* providerStatus("claude");
			},
		);

		const disconnect = Effect.fn("AccountAccess.disconnect")(function* (
			providerId: AccountAccessProvider,
		) {
			yield* requireRole("cloud-environment");
			if (providerId === "claude") {
				yield* credentials
					.remove("claude")
					.pipe(
						Effect.mapError(
							() => new AccountAccessServiceError("credential-store-failed"),
						),
					);
			} else {
				const result = yield* capture(
					providerId === "github" ? "gh" : "codex",
					providerId === "github"
						? ["auth", "logout", "--hostname", "github.com"]
						: ["logout"],
				).pipe(
					Effect.orElseSucceed(() => ({
						stdout: "",
						stderr: "",
						code: 1,
					})),
				);
				if (result.code !== 0) {
					return yield* Effect.fail(
						new AccountAccessServiceError("login-failed"),
					);
				}
			}
			return yield* providerStatus(providerId);
		});

		const sanitizeCredentials = Effect.fn("AccountAccess.sanitizeCredentials")(
			function* () {
				yield* requireRole("cloud-environment");
				const accountHome =
					process.env.ZUSE_ACCOUNT_ACCESS_HOME?.trim() || homedir();
				const credentialPaths = [
					join(paths.userData, "secrets", "credentials.json"),
					join(accountHome, ".config", "gh", "hosts.yml"),
					join(accountHome, ".codex", "auth.json"),
					join(accountHome, ".claude", ".credentials.json"),
				];
				yield* Effect.all(
					[
						capture("gh", ["auth", "logout", "--hostname", "github.com"]),
						capture("codex", ["logout"]),
					].map((effect) => Effect.ignore(effect)),
					{ concurrency: 2 },
				);
				yield* Effect.tryPromise({
					try: async () => {
						for (const credentialPath of credentialPaths) {
							await rm(credentialPath, { force: true });
						}
						for (const credentialPath of credentialPaths) {
							try {
								await lstat(credentialPath);
								throw new Error("credential_path_remains");
							} catch (cause) {
								if (
									cause instanceof Error &&
									"code" in cause &&
									cause.code === "ENOENT"
								) {
									continue;
								}
								throw cause;
							}
						}
					},
					catch: () => new AccountAccessServiceError("cleanup-failed"),
				});
			},
		);

		const requestRuntimeStop = Effect.fn("AccountAccess.requestRuntimeStop")(
			function* () {
				yield* requireRole("cloud-environment");
				const marker = join(paths.userData, "credential-cleanup-ready");
				yield* Effect.tryPromise({
					try: async () => {
						await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
						await writeFile(marker, "sanitized\n", { mode: 0o600 });
					},
					catch: () => new AccountAccessServiceError("cleanup-failed"),
				});
			},
		);

		return AccountAccessService.of({
			status,
			detectLocal,
			startLogin,
			prepareImport,
			createClaudeTransfer,
			continueClaudeTransfer,
			importCredential,
			disconnect,
			sanitizeCredentials,
			requestRuntimeStop,
		});
	}),
);
