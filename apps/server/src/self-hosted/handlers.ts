import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";

import {
	MemoizeRpcs,
	SelfHostedDiagnosticsBundle,
	SelfHostedGithubLoginState,
	SelfHostedHostError,
	SelfHostedHostHealth,
	SelfHostedRuntimeActionResult,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { ApiLinkService } from "../api/api-link-service.ts";

const execFileAsync = promisify(execFile);

type GithubLoginOperation = {
	readonly child: ChildProcessWithoutNullStreams;
	state: SelfHostedGithubLoginState;
};

const githubOperations = new Map<string, GithubLoginOperation>();

const assertSelfHosted = (): Effect.Effect<void, SelfHostedHostError> =>
	process.env.ZUSE_SELF_HOSTED === "1"
		? Effect.void
		: Effect.fail(new SelfHostedHostError({ reason: "not-self-hosted" }));

const githubStatus = async (): Promise<SelfHostedGithubLoginState> => {
	try {
		await execFileAsync("gh", ["auth", "status", "--hostname", "github.com"], {
			timeout: 5_000,
			maxBuffer: 8_192,
		});
		return SelfHostedGithubLoginState.make({ state: "connected" });
	} catch {
		return SelfHostedGithubLoginState.make({ state: "disconnected" });
	}
};

const commandVersion = async (command: string): Promise<string | null> => {
	try {
		const { stdout } = await execFileAsync(command, ["--version"], {
			timeout: 3_000,
			maxBuffer: 8_192,
		});
		return stdout.trim().split(/\r?\n/u)[0] ?? null;
	} catch {
		return null;
	}
};

const readOsRelease = async (): Promise<{
	readonly osId: string;
	readonly osVersion: string;
}> => {
	const contents = await readFile("/etc/os-release", "utf8").catch(() => "");
	const fields = new Map(
		contents
			.split(/\r?\n/u)
			.map((line) => line.split("=", 2) as [string, string])
			.map(([key, value]) => [key, value?.replace(/^"|"$/gu, "") ?? ""]),
	);
	return {
		osId: fields.get("ID") ?? process.platform,
		osVersion: fields.get("VERSION_ID") ?? "unknown",
	};
};

const Status = MemoizeRpcs.toLayerHandler("host.status", () =>
	Effect.gen(function* () {
		yield* assertSelfHosted();
		const api = yield* (yield* ApiLinkService)
			.status()
			.pipe(
				Effect.mapError(
					() => new SelfHostedHostError({ reason: "unavailable" }),
				),
			);
		return yield* Effect.tryPromise({
			try: async () => {
				const [os, disk, gitVersion, githubCliVersion] = await Promise.all([
					readOsRelease(),
					statfs(process.env.HOME ?? process.cwd()),
					commandVersion("git"),
					commandVersion("gh"),
				]);
				const blockSize = Number(disk.bsize);
				return SelfHostedHostHealth.make({
					...os,
					architecture: process.arch === "arm64" ? "arm64" : "x86_64",
					cpuCores: cpus().length,
					memoryTotalBytes: totalmem(),
					memoryAvailableBytes: freemem(),
					diskTotalBytes: Number(disk.blocks) * blockSize,
					diskAvailableBytes: Number(disk.bavail) * blockSize,
					nodeVersion: process.version,
					gitVersion,
					githubCliVersion,
					zuseVersion:
						process.env.ZUSE_RUNTIME_VERSION ??
						process.env.npm_package_version ??
						"unknown",
					serviceState: "running",
					apiLinked: api.linked,
					apiHeartbeatActive: api.heartbeatActive,
					sampledAt: Date.now(),
				});
			},
			catch: () => new SelfHostedHostError({ reason: "unavailable" }),
		});
	}),
);

const Detach = MemoizeRpcs.toLayerHandler("host.detach", () =>
	Effect.gen(function* () {
		yield* assertSelfHosted();
		const api = yield* ApiLinkService;
		yield* api
			.unlink()
			.pipe(
				Effect.mapError(
					() => new SelfHostedHostError({ reason: "unavailable" }),
				),
			);
		yield* Effect.sync(() => {
			const timer = setTimeout(() => {
				const child = execFile("systemctl", [
					"--user",
					"stop",
					"zuse-serve.service",
				]);
				child.unref();
			}, 750);
			timer.unref();
		});
	}),
);

const scheduleServiceRestart = (): void => {
	const timer = setTimeout(() => {
		const child = spawn(
			"systemctl",
			["--user", "restart", "zuse-serve.service"],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
	}, 750);
	timer.unref();
};

const RuntimeRestart = MemoizeRpcs.toLayerHandler(
	"host.runtime.restart",
	({ force }) =>
		Effect.gen(function* () {
			yield* assertSelfHosted();
			if (!force) {
				return yield* new SelfHostedHostError({ reason: "unavailable" });
			}
			yield* Effect.sync(scheduleServiceRestart);
			return SelfHostedRuntimeActionResult.make({
				action: "restart",
				accepted: true,
				requestedAt: Date.now(),
			});
		}),
);

const RuntimeUpdate = MemoizeRpcs.toLayerHandler(
	"host.runtime.update",
	({ force }) =>
		Effect.gen(function* () {
			yield* assertSelfHosted();
			if (!force || process.argv[1] === undefined) {
				return yield* new SelfHostedHostError({ reason: "unavailable" });
			}
			const dataIndex = process.argv.indexOf("--data-dir");
			const dataDir = dataIndex < 0 ? undefined : process.argv[dataIndex + 1];
			yield* Effect.sync(() => {
				const child = spawn(
					process.execPath,
					[
						process.argv[1] as string,
						"serve",
						"update",
						"--force",
						...(dataDir === undefined ? [] : ["--data-dir", dataDir]),
					],
					{ detached: true, stdio: "ignore" },
				);
				child.unref();
			});
			return SelfHostedRuntimeActionResult.make({
				action: "update",
				accepted: true,
				requestedAt: Date.now(),
			});
		}),
);

const Diagnostics = MemoizeRpcs.toLayerHandler("host.diagnostics", () =>
	Effect.gen(function* () {
		yield* assertSelfHosted();
		const now = new Date();
		return SelfHostedDiagnosticsBundle.make({
			fileName: `zuse-self-hosted-${now.toISOString().replaceAll(":", "-")}.json`,
			content: `${JSON.stringify(
				{
					generatedAt: now.toISOString(),
					platform: process.platform,
					architecture: process.arch,
					nodeVersion: process.version,
					zuseVersion:
						process.env.ZUSE_RUNTIME_VERSION ??
						process.env.npm_package_version ??
						"unknown",
					serviceMode: "self-hosted",
					cpuCores: cpus().length,
					memoryTotalBytes: totalmem(),
					memoryAvailableBytes: freemem(),
				},
				null,
				2,
			)}\n`,
		});
	}),
);

const GithubStatus = MemoizeRpcs.toLayerHandler("host.github.status", () =>
	assertSelfHosted().pipe(
		Effect.flatMap(() =>
			Effect.tryPromise({
				try: githubStatus,
				catch: () => new SelfHostedHostError({ reason: "unavailable" }),
			}),
		),
	),
);

const GithubLoginStart = MemoizeRpcs.toLayerHandler(
	"host.github.loginStart",
	() =>
		Effect.gen(function* () {
			yield* assertSelfHosted();
			const operationId = randomUUID();
			const child = spawn(
				"gh",
				[
					"auth",
					"login",
					"--hostname",
					"github.com",
					"--git-protocol",
					"https",
					"--web",
					"--skip-ssh-key",
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			const operation: GithubLoginOperation = {
				child,
				state: SelfHostedGithubLoginState.make({
					operationId,
					state: "authorizing",
					verificationUrl: "https://github.com/login/device",
				}),
			};
			githubOperations.set(operationId, operation);
			let buffered = "";
			const inspect = (chunk: unknown): void => {
				buffered =
					`${buffered}${Buffer.from(chunk as Uint8Array).toString("utf8")}`.slice(
						-4_096,
					);
				const code = buffered.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/u)?.[0];
				if (code !== undefined) {
					operation.state = SelfHostedGithubLoginState.make({
						...operation.state,
						verificationCode: code,
					});
				}
			};
			child.stdout.on("data", inspect);
			child.stderr.on("data", inspect);
			child.once("error", () => {
				operation.state = SelfHostedGithubLoginState.make({
					operationId,
					state: "error",
					errorCode: "github_cli_unavailable",
				});
			});
			child.once("exit", (code) => {
				if (operation.state.state === "cancelled") return;
				operation.state = SelfHostedGithubLoginState.make({
					operationId,
					state: code === 0 ? "connected" : "error",
					...(code === 0 ? {} : { errorCode: "github_authorization_failed" }),
				});
				if (code === 0) {
					const setup = execFile("gh", [
						"auth",
						"setup-git",
						"--hostname",
						"github.com",
					]);
					setup.unref();
				}
				const cleanup = setTimeout(
					() => githubOperations.delete(operationId),
					10 * 60_000,
				);
				cleanup.unref();
			});
			child.stdin.write("\n");
			return operation.state;
		}),
);

const GithubLoginPoll = MemoizeRpcs.toLayerHandler(
	"host.github.loginPoll",
	({ operationId }) =>
		assertSelfHosted().pipe(
			Effect.map(
				() =>
					githubOperations.get(operationId)?.state ??
					SelfHostedGithubLoginState.make({
						operationId,
						state: "error",
						errorCode: "operation_not_found",
					}),
			),
		),
);

const GithubLoginCancel = MemoizeRpcs.toLayerHandler(
	"host.github.loginCancel",
	({ operationId }) =>
		assertSelfHosted().pipe(
			Effect.map(() => {
				const operation = githubOperations.get(operationId);
				operation?.child.kill("SIGTERM");
				const state = SelfHostedGithubLoginState.make({
					operationId,
					state: "cancelled",
				});
				if (operation !== undefined) operation.state = state;
				return state;
			}),
		),
);

const GithubLogout = MemoizeRpcs.toLayerHandler("host.github.logout", () =>
	assertSelfHosted().pipe(
		Effect.flatMap(() =>
			Effect.tryPromise({
				try: async () => {
					const child = spawn(
						"gh",
						["auth", "logout", "--hostname", "github.com"],
						{ stdio: ["pipe", "ignore", "ignore"] },
					);
					child.stdin.end("y\n");
					await new Promise<void>((resolve, reject) => {
						child.once("error", reject);
						child.once("exit", (code) =>
							code === 0 ? resolve() : reject(new Error("logout_failed")),
						);
					});
					return SelfHostedGithubLoginState.make({ state: "disconnected" });
				},
				catch: () => new SelfHostedHostError({ reason: "unavailable" }),
			}),
		),
	),
);

export const SelfHostedHostHandlersLayer = Layer.mergeAll(
	Status,
	Detach,
	RuntimeRestart,
	RuntimeUpdate,
	Diagnostics,
	GithubStatus,
	GithubLoginStart,
	GithubLoginPoll,
	GithubLoginCancel,
	GithubLogout,
);
