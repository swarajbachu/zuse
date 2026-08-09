import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
	MachinePrivateNetworkStatus,
	MachineSshKey,
	SshMode,
} from "@zuse/contracts";
import { MachineRuntimeStatus, RelayPaths } from "@zuse/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import { AppPaths } from "../app-paths.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { MachineControlError } from "./machine-control-service.ts";
import { MachineRuntimeRole } from "./machine-runtime-role.ts";

export interface MachinePrivateEndpointPublisherShape {
	readonly publish: (
		status: MachinePrivateNetworkStatus,
	) => Effect.Effect<void, MachineControlError>;
}

export class MachinePrivateEndpointPublisher extends Context.Service<
	MachinePrivateEndpointPublisher,
	MachinePrivateEndpointPublisherShape
>()("zuse/MachinePrivateEndpointPublisher") {}

export const MachinePrivateEndpointPublisherLive: Layer.Layer<
	MachinePrivateEndpointPublisher,
	never,
	LanAuthService
> = Layer.effect(
	MachinePrivateEndpointPublisher,
	Effect.gen(function* () {
		const auth = yield* LanAuthService;
		return MachinePrivateEndpointPublisher.of({
			publish: (status) =>
				Effect.gen(function* () {
					if (status.enabled !== true || status.privateIp === undefined) return;
					const config = yield* auth
						.getRelayConfig()
						.pipe(
							Effect.mapError(
								() => new MachineControlError("provider-unavailable"),
							),
						);
					if (config === null) return;
					const port = Number(process.env.ZUSE_PORT ?? "47837");
					const endpoint = {
						httpBaseUrl: `http://${status.privateIp}:${port}`,
						wsBaseUrl: `ws://${status.privateIp}:${port}`,
					};
					yield* Effect.tryPromise({
						try: async () => {
							const response = await fetch(
								`${config.relayUrl}${RelayPaths.heartbeat(config.environmentId)}`,
								{
									method: "POST",
									headers: {
										authorization: `Bearer ${config.environmentCredential}`,
										"content-type": "application/json",
									},
									body: JSON.stringify({ privateEndpoint: endpoint }),
								},
							);
							if (!response.ok) throw new Error(`relay_${response.status}`);
						},
						catch: () => new MachineControlError("provider-unavailable"),
					});
				}),
		});
	}),
);

export interface MachineHostServiceShape {
	readonly addSshKey: (
		publicKey: string,
		label?: string,
	) => Effect.Effect<MachineSshKey, MachineControlError>;
	readonly listSshKeys: () => Effect.Effect<
		ReadonlyArray<MachineSshKey>,
		MachineControlError
	>;
	readonly removeSshKey: (
		fingerprint: string,
	) => Effect.Effect<void, MachineControlError>;
	readonly enablePrivateNetwork: (
		authKey: string,
		sshMode: SshMode,
	) => Effect.Effect<MachinePrivateNetworkStatus, MachineControlError>;
	readonly privateNetworkStatus: () => Effect.Effect<
		MachinePrivateNetworkStatus,
		MachineControlError
	>;
	readonly setSshMode: (
		mode: SshMode,
	) => Effect.Effect<MachinePrivateNetworkStatus, MachineControlError>;
	readonly runtimeTarget: () => Effect.Effect<
		{ readonly appVersion: string },
		MachineControlError
	>;
	readonly runtimeStatus: (
		targetAppVersion: string,
	) => Effect.Effect<MachineRuntimeStatus, MachineControlError>;
	readonly requestRuntimeUpdate: (
		targetAppVersion: string,
	) => Effect.Effect<MachineRuntimeStatus, MachineControlError>;
}

export class MachineHostService extends Context.Service<
	MachineHostService,
	MachineHostServiceShape
>()("zuse/MachineHostService") {}

const normalizedKey = (input: string): string => {
	const fields = input.trim().split(/\s+/u);
	const [kind, encoded, ...comment] = fields;
	if (
		kind === undefined ||
		encoded === undefined ||
		!/^(ssh-(ed25519|rsa)|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/u.test(kind)
	) {
		throw new MachineControlError("invalid-request");
	}
	try {
		Buffer.from(encoded, "base64");
	} catch {
		throw new MachineControlError("invalid-request");
	}
	return [kind, encoded, ...comment].join(" ");
};

const fingerprint = (publicKey: string): string => {
	const encoded = publicKey.split(/\s+/u)[1];
	if (encoded === undefined) throw new MachineControlError("invalid-request");
	return `SHA256:${createHash("sha256")
		.update(Buffer.from(encoded, "base64"))
		.digest("base64")
		.replace(/=+$/u, "")}`;
};

const sshKey = (publicKey: string): MachineSshKey => {
	const fields = publicKey.split(/\s+/u);
	return {
		fingerprint: fingerprint(publicKey),
		publicKey,
		label: fields.slice(2).join(" ") || undefined,
	};
};

const run = (
	command: string,
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
			reject(
				new Error(
					Buffer.concat(stderr).toString("utf8").trim() ||
						`${command} exited with ${code}`,
				),
			);
		});
	});

const PrivateNetworkStatusPayload = Schema.Struct({
	TailscaleIPs: Schema.optional(Schema.Array(Schema.String)),
	Self: Schema.optional(
		Schema.Struct({
			DNSName: Schema.optional(Schema.String),
		}),
	),
});

export const MachineHostServiceLive: Layer.Layer<
	MachineHostService,
	never,
	AppPaths | MachinePrivateEndpointPublisher | MachineRuntimeRole
> = Layer.effect(
	MachineHostService,
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const endpointPublisher = yield* MachinePrivateEndpointPublisher;
		const runtimeRole = yield* MachineRuntimeRole;
		const authorizedKeys =
			process.env.ZUSE_AUTHORIZED_KEYS_FILE ??
			join(homedir(), ".ssh", "authorized_keys");
		const modeFile = join(paths.userData, "secrets", "ssh-mode");
		const runtimeUpdateDirectory = join(paths.userData, "runtime-update");
		const runtimeUpdateRequest = join(runtimeUpdateDirectory, "request.json");
		const runtimeUpdateStatus = join(runtimeUpdateDirectory, "status.json");
		const runtimeUpdater =
			process.env.ZUSE_RUNTIME_UPDATER_PATH ??
			"/opt/zuse/current/runtime-updater.mjs";
		let fileTail: Promise<void> = Promise.resolve();

		const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
			const result = fileTail.then(operation, operation);
			fileTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		};
		const effect = <A>(operation: () => Promise<A>) =>
			runtimeRole !== "cloud-environment"
				? Effect.fail(new MachineControlError("not-allowed"))
				: Effect.tryPromise({
						try: () => exclusive(operation),
						catch: (cause) =>
							cause instanceof MachineControlError
								? cause
								: new MachineControlError("provider-unavailable"),
					});
		const validAppVersion = (value: string): string => {
			const normalized = value.trim();
			if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(normalized)) {
				throw new MachineControlError("invalid-request");
			}
			return normalized;
		};
		const readRuntimeStatus = async (
			targetAppVersion: string,
		): Promise<MachineRuntimeStatus> => {
			const target = validAppVersion(targetAppVersion);
			const raw = await run(process.execPath, [runtimeUpdater, "--check"], {
				...process.env,
				ZUSE_RUNTIME_DESIRED_APP_VERSION: target,
				ZUSE_RUNTIME_UPDATE_STATUS_FILE: runtimeUpdateStatus,
			});
			return Schema.decodeUnknownSync(MachineRuntimeStatus)(JSON.parse(raw));
		};
		const readKeys = async (): Promise<ReadonlyArray<MachineSshKey>> => {
			try {
				return (await readFile(authorizedKeys, "utf8"))
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0 && !line.startsWith("#"))
					.map(sshKey);
			} catch (cause) {
				if (
					cause instanceof Error &&
					"code" in cause &&
					cause.code === "ENOENT"
				) {
					return [];
				}
				throw cause;
			}
		};
		const writeKeys = async (
			keys: ReadonlyArray<MachineSshKey>,
		): Promise<void> => {
			await mkdir(dirname(authorizedKeys), { recursive: true, mode: 0o700 });
			await chmod(dirname(authorizedKeys), 0o700);
			const temporary = `${authorizedKeys}.${process.pid}.tmp`;
			await writeFile(
				temporary,
				keys.length === 0
					? ""
					: `${keys.map((key) => key.publicKey).join("\n")}\n`,
				{ mode: 0o600 },
			);
			await chmod(temporary, 0o600);
			await rename(temporary, authorizedKeys);
			await chmod(authorizedKeys, 0o600);
		};
		const readMode = async (): Promise<SshMode> => {
			try {
				return (await readFile(modeFile, "utf8")).trim() === "tailnet-identity"
					? "tailnet-identity"
					: "authorized-keys";
			} catch (cause) {
				if (
					cause instanceof Error &&
					"code" in cause &&
					cause.code === "ENOENT"
				) {
					return "authorized-keys";
				}
				throw cause;
			}
		};
		const writeMode = async (mode: SshMode): Promise<void> => {
			await mkdir(dirname(modeFile), { recursive: true, mode: 0o700 });
			const temporary = `${modeFile}.${process.pid}.tmp`;
			await writeFile(temporary, `${mode}\n`, { mode: 0o600 });
			await rename(temporary, modeFile);
			await chmod(modeFile, 0o600);
		};
		const status = async (): Promise<MachinePrivateNetworkStatus> => {
			const mode = await readMode();
			let raw: string;
			try {
				raw = await run("tailscale", ["status", "--json"]);
			} catch {
				return { enabled: false, sshMode: mode };
			}
			const parsed = Schema.decodeUnknownSync(PrivateNetworkStatusPayload)(
				JSON.parse(raw) as unknown,
			);
			return {
				enabled: true,
				privateIp: parsed.TailscaleIPs?.[0],
				dnsName: parsed.Self?.DNSName?.replace(/\.$/u, ""),
				sshMode: mode,
			};
		};
		const setMode = async (mode: SshMode): Promise<void> => {
			await run("tailscale", [
				"set",
				`--ssh=${mode === "tailnet-identity" ? "true" : "false"}`,
			]);
			await writeMode(mode);
		};

		return MachineHostService.of({
			runtimeTarget: () =>
				runtimeRole === "control-plane"
					? Effect.succeed({
							appVersion: process.env.ZUSE_APP_VERSION?.trim() || "0.0.0",
						})
					: Effect.fail(new MachineControlError("not-allowed")),
			runtimeStatus: (targetAppVersion) =>
				effect(() => readRuntimeStatus(targetAppVersion)),
			requestRuntimeUpdate: (targetAppVersion) =>
				effect(async () => {
					const target = validAppVersion(targetAppVersion);
					const status = await readRuntimeStatus(target);
					if (status.state === "current" || status.state === "updating") {
						return status;
					}
					if (status.state !== "update-available") {
						throw new MachineControlError("provider-unavailable");
					}
					await mkdir(runtimeUpdateDirectory, {
						recursive: true,
						mode: 0o770,
					});
					const queued = new MachineRuntimeStatus({
						...status,
						state: "updating",
						phase: "queued",
						progressPercent: 2,
						updatedAt: Date.now(),
					});
					const statusTemporary = `${runtimeUpdateStatus}.${process.pid}.tmp`;
					await writeFile(statusTemporary, `${JSON.stringify(queued)}\n`, {
						mode: 0o644,
					});
					await rename(statusTemporary, runtimeUpdateStatus);
					const requestTemporary = `${runtimeUpdateRequest}.${process.pid}.tmp`;
					await writeFile(
						requestTemporary,
						`${JSON.stringify({ targetAppVersion: target })}\n`,
						{ mode: 0o600 },
					);
					await rename(requestTemporary, runtimeUpdateRequest);
					return queued;
				}),
			addSshKey: (publicKey, label) =>
				effect(async () => {
					const key = normalizedKey(
						label === undefined ? publicKey : `${publicKey} ${label}`,
					);
					const record = sshKey(key);
					const keys = await readKeys();
					if (!keys.some((item) => item.fingerprint === record.fingerprint)) {
						await writeKeys([...keys, record]);
					}
					return record;
				}),
			listSshKeys: () => effect(readKeys),
			removeSshKey: (keyFingerprint) =>
				effect(async () => {
					const keys = await readKeys();
					await writeKeys(
						keys.filter((key) => key.fingerprint !== keyFingerprint),
					);
				}),
			enablePrivateNetwork: (authKey, mode) =>
				effect(async () => {
					const authFile = join(
						paths.userData,
						"secrets",
						`network-auth-${randomUUID()}`,
					);
					await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
					await writeFile(authFile, authKey, { mode: 0o600 });
					try {
						await run("tailscale", [
							"up",
							`--auth-key=file:${authFile}`,
							`--ssh=${mode === "tailnet-identity" ? "true" : "false"}`,
						]);
					} finally {
						await unlink(authFile).catch(() => undefined);
					}
					await writeMode(mode);
					const currentStatus = await status();
					await Effect.runPromise(endpointPublisher.publish(currentStatus));
					return currentStatus;
				}),
			privateNetworkStatus: () => effect(status),
			setSshMode: (mode) =>
				effect(async () => {
					await setMode(mode);
					return status();
				}),
		});
	}),
);
