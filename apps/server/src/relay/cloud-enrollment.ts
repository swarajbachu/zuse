import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	DEFAULT_LOCAL_DESKTOP_PORT,
	MachineEnrollResponse,
	MachineRecord,
	RelayPaths,
} from "@zuse/contracts";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";

import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { CredentialsService } from "../provider/services/credentials-service.ts";
import { signEnvironmentLinkProof } from "./link-proof.ts";
import { ManagedTunnelRuntime } from "./managed-tunnel-runtime.ts";

export interface CloudEnrollmentConfig {
	readonly machineId: string;
	readonly resourceKind?: "machine" | "workspace";
	readonly relayUrl: string;
	readonly relayIssuer: string;
	readonly token: Redacted.Redacted<string>;
	readonly tokenFile?: string;
	readonly label?: string;
	readonly port?: number;
}

export class CloudEnrollmentError extends Schema.TaggedErrorClass<CloudEnrollmentError>()(
	"CloudEnrollmentError",
	{ reason: Schema.String },
) {}

const fail = (reason: string) => new CloudEnrollmentError({ reason });

const RelayErrorBody = Schema.Struct({
	error: Schema.optional(Schema.String),
});

const post = <A, I>(
	schema: Schema.Codec<A, I>,
	url: string,
	token: string,
	body: unknown,
): Effect.Effect<A, CloudEnrollmentError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const payload: unknown = await response.json().catch(() => ({}));
				const decoded = Schema.decodeUnknownExit(RelayErrorBody)(payload);
				throw new Error(
					decoded._tag === "Success" && decoded.value.error !== undefined
						? decoded.value.error
						: `relay_${response.status}`,
				);
			}
			return response.json() as Promise<unknown>;
		},
		catch: (cause) =>
			fail(cause instanceof Error ? cause.message : String(cause)),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError((error) =>
			error instanceof CloudEnrollmentError
				? error
				: fail("relay_invalid_response"),
		),
	);

const removeEnrollmentToken = (
	tokenFile: string | undefined,
): Effect.Effect<void, CloudEnrollmentError> =>
	tokenFile === undefined
		? Effect.void
		: Effect.tryPromise({
				try: () => unlink(tokenFile),
				catch: (cause) => {
					if (
						cause instanceof Error &&
						"code" in cause &&
						cause.code === "ENOENT"
					) {
						return fail("enrollment_token_file_missing");
					}
					return fail("enrollment_token_file_remove_failed");
				},
			});

const installCloudCredentials = Effect.fn("installCloudCredentials")(function* (
	credentials: MachineEnrollResponse["cloudCredentials"],
) {
	if (credentials === undefined) return;
	const credentialStore = yield* CredentialsService;
	for (const credential of credentials) {
		if (credential.kind === "github") {
			const accountHome =
				process.env.ZUSE_ACCOUNT_ACCESS_HOME?.trim() || homedir();
			const hostsFile = join(accountHome, ".config", "gh", "hosts.yml");
			const gitConfigFile = join(accountHome, ".gitconfig");
			yield* Effect.tryPromise({
				try: async () => {
					await mkdir(dirname(hostsFile), { recursive: true, mode: 0o700 });
					await chmod(dirname(hostsFile), 0o700);
					await writeFile(
						hostsFile,
						`github.com:\n    oauth_token: ${JSON.stringify(credential.secret)}\n    git_protocol: https\n`,
						{ encoding: "utf8", mode: 0o600 },
					);
					await chmod(hostsFile, 0o600);
					await writeFile(
						gitConfigFile,
						'[credential "https://github.com"]\n\thelper = !gh auth git-credential\n',
						{ encoding: "utf8", mode: 0o600 },
					);
					await chmod(gitConfigFile, 0o600);
				},
				catch: () => fail("credential_install_failed"),
			});
			continue;
		}
		if (credential.credentialType === "native-store") {
			const accountHome =
				process.env.ZUSE_ACCOUNT_ACCESS_HOME?.trim() || homedir();
			const credentialFile =
				credential.kind === "claude"
					? join(accountHome, ".claude", ".credentials.json")
					: join(accountHome, ".codex", "auth.json");
			yield* Effect.tryPromise({
				try: async () => {
					JSON.parse(credential.secret);
					await mkdir(dirname(credentialFile), {
						recursive: true,
						mode: 0o700,
					});
					await chmod(dirname(credentialFile), 0o700);
					await writeFile(credentialFile, credential.secret, {
						encoding: "utf8",
						mode: 0o600,
					});
					await chmod(credentialFile, 0o600);
				},
				catch: () => fail("credential_install_failed"),
			});
			continue;
		}
		yield* credentialStore
			.setProviderCredential(credential.kind, {
				kind:
					credential.credentialType === "oauth-token"
						? "oauth-token"
						: "api-key",
				secret: credential.secret,
			})
			.pipe(Effect.mapError(() => fail("credential_install_failed")));
	}
});

/**
 * One-shot cloud enrollment. The layer is initialized before the normal relay
 * link service, so that service immediately resumes the connector and
 * heartbeat from the newly persisted relay configuration.
 */
export const makeCloudEnrollmentLayer = (
	config: CloudEnrollmentConfig | undefined,
): Layer.Layer<
	never,
	CloudEnrollmentError,
	LanAuthService | ManagedTunnelRuntime | CredentialsService
> =>
	config === undefined
		? Layer.empty
		: Layer.effectDiscard(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const existing = yield* auth
						.getRelayConfig()
						.pipe(Effect.mapError((error) => fail(error.reason)));
					if (existing !== null) {
						yield* removeEnrollmentToken(config.tokenFile).pipe(Effect.ignore);
						return;
					}

					const token = Redacted.value(config.token);
					const port = config.port ?? DEFAULT_LOCAL_DESKTOP_PORT;
					const keys = yield* auth
						.environmentKeys()
						.pipe(Effect.mapError((error) => fail(error.reason)));
					if (config.resourceKind !== "workspace") {
						yield* post(
							MachineRecord,
							`${config.relayUrl}${RelayPaths.machineBootStatus(config.machineId)}`,
							token,
							{ phase: "service-started" },
						);
					}
					const nowMs = yield* Clock.currentTimeMillis;
					const proof = yield* signEnvironmentLinkProof({
						privateJwk: keys.privateJwk,
						challenge: token,
						environmentId: keys.envId,
						relayIssuer: config.relayIssuer,
						nowMs,
					});
					const enrolled = yield* post(
						MachineEnrollResponse,
						`${config.relayUrl}${config.resourceKind === "workspace" ? RelayPaths.cloudWorkspaceEnroll : RelayPaths.machineEnroll}`,
						token,
						{
							machineId: config.machineId,
							environmentId: keys.envId,
							environmentPublicKey: keys.publicJwk,
							proof,
							endpoint: {
								httpBaseUrl: `http://127.0.0.1:${port}`,
								wsBaseUrl: `ws://127.0.0.1:${port}`,
							},
							origin: {
								localHttpHost: "127.0.0.1",
								localHttpPort: port,
							},
							label: config.label,
						},
					);
					const tunnel = yield* ManagedTunnelRuntime;
					if (enrolled.connectorToken !== undefined) {
						yield* tunnel
							.start(enrolled.connectorToken)
							.pipe(Effect.mapError((error) => fail(error.reason)));
					}
					yield* auth
						.saveRelayConfig({
							relayUrl: config.relayUrl,
							relayIssuer: enrolled.relayIssuer,
							environmentId: enrolled.environmentId,
							environmentCredential: enrolled.environmentCredential,
							label: config.label,
							connectorToken: enrolled.connectorToken,
							tunnelHostname: enrolled.tunnelHostname,
							mintPublicKey: enrolled.mintPublicKey,
						})
						.pipe(Effect.mapError((error) => fail(error.reason)));
					yield* installCloudCredentials(enrolled.cloudCredentials);
					if (config.resourceKind === "workspace") {
						yield* Effect.tryPromise({
							try: async () => {
								const marker = "/var/lib/zuse/workspace/credentials-ready";
								await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
								await writeFile(marker, "ready\n", { mode: 0o600 });
							},
							catch: () => fail("workspace_ready_marker_failed"),
						});
					}
					yield* removeEnrollmentToken(config.tokenFile);
				}),
			);
