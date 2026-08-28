import { unlink } from "node:fs/promises";

import {
	ApiPaths,
	DEFAULT_LOCAL_DESKTOP_PORT,
	MachineEnrollResponse,
	MachineRecord,
} from "@zuse/contracts";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";

import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { signEnvironmentLinkProof } from "./link-proof.ts";
import { ManagedTunnelRuntime } from "./managed-tunnel-runtime.ts";

export interface CloudEnrollmentConfig {
	readonly machineId: string;
	readonly apiUrl: string;
	readonly apiIssuer: string;
	readonly token: Redacted.Redacted<string>;
	readonly tokenFile?: string;
	readonly label?: string;
	readonly port?: number;
}

export class CloudEnrollmentError extends Schema.TaggedErrorClass<CloudEnrollmentError>()(
	"CloudEnrollmentError",
	{ reason: Schema.String, message: Schema.String },
) {}

const fail = (reason: string) =>
	new CloudEnrollmentError({ reason, message: reason });

const ApiErrorBody = Schema.Struct({
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
				const decoded = Schema.decodeUnknownExit(ApiErrorBody)(payload);
				throw new Error(
					decoded._tag === "Success" && decoded.value.error !== undefined
						? decoded.value.error
						: `api_${response.status}`,
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
				: fail("api_invalid_response"),
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

/**
 * One-shot cloud enrollment. The layer is initialized before the normal api
 * link service, so that service immediately resumes the connector and
 * heartbeat from the newly persisted api configuration.
 */
export const makeCloudEnrollmentLayer = (
	config: CloudEnrollmentConfig | undefined,
): Layer.Layer<
	never,
	CloudEnrollmentError,
	LanAuthService | ManagedTunnelRuntime
> =>
	config === undefined
		? Layer.empty
		: Layer.effectDiscard(
				Effect.gen(function* () {
					const auth = yield* LanAuthService;
					const existing = yield* auth
						.getApiConfig()
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
					yield* post(
						MachineRecord,
						`${config.apiUrl}${ApiPaths.machineBootStatus(config.machineId)}`,
						token,
						{ phase: "service-started" },
					);
					const nowMs = yield* Clock.currentTimeMillis;
					const proof = yield* signEnvironmentLinkProof({
						privateJwk: keys.privateJwk,
						challenge: token,
						environmentId: keys.envId,
						apiIssuer: config.apiIssuer,
						nowMs,
					});
					const enrolled = yield* post(
						MachineEnrollResponse,
						`${config.apiUrl}${ApiPaths.machineEnroll}`,
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
						.saveApiConfig({
							apiUrl: config.apiUrl,
							apiIssuer: enrolled.apiIssuer,
							environmentId: enrolled.environmentId,
							environmentCredential: enrolled.environmentCredential,
							label: config.label,
							connectorToken: enrolled.connectorToken,
							tunnelHostname: enrolled.tunnelHostname,
							mintPublicKey: enrolled.mintPublicKey,
						})
						.pipe(Effect.mapError((error) => fail(error.reason)));
					yield* removeEnrollmentToken(config.tokenFile);
				}),
			);
