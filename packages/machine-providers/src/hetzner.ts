import { Effect, Redacted, Schema } from "effect";
import {
	type MachineProviderAdapter,
	MachineProviderError,
	type ProviderMachine,
} from "./index.ts";

const ApiServer = Schema.Struct({
	id: Schema.Union([Schema.Number, Schema.String]),
	name: Schema.String,
	status: Schema.String,
	backup_window: Schema.optional(Schema.NullOr(Schema.String)),
});

const ServerResponse = Schema.Struct({ server: ApiServer });
const ServerListResponse = Schema.Struct({ servers: Schema.Array(ApiServer) });
const SnapshotResponse = Schema.Struct({
	image: Schema.Struct({
		id: Schema.Union([Schema.Number, Schema.String]),
	}),
});
const ServerTypeListResponse = Schema.Struct({
	server_types: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			cores: Schema.Number,
			memory: Schema.Number,
			disk: Schema.Number,
			architecture: Schema.String,
			locations: Schema.Array(
				Schema.Struct({
					name: Schema.String,
					available: Schema.Boolean,
				}),
			),
		}),
	),
});

type ApiServer = Schema.Schema.Type<typeof ApiServer>;

export interface HetznerOfferProfile {
	readonly serverType: string;
	readonly image: string;
	readonly location: string;
	readonly firewallId: number;
}

export interface HetznerMachineConfig {
	readonly accessToken: Redacted.Redacted<string>;
	readonly apiBaseUrl?: string;
	readonly offerProfiles: Readonly<Record<string, HetznerOfferProfile>>;
	readonly renderUserData: (input: {
		readonly machineId: string;
		readonly providerLabel: string;
		readonly enrollmentToken: string;
	}) => string;
}

export interface HetznerHttpClient {
	readonly fetch: typeof globalThis.fetch;
}

const providerError = (
	code: MachineProviderError["code"],
): MachineProviderError => new MachineProviderError({ code });

const errorForStatus = (status: number): MachineProviderError =>
	status === 404
		? providerError("not-found")
		: status === 400 || status === 401 || status === 403 || status === 422
			? providerError("rejected")
			: providerError("transient");

const toProviderMachine = (server: ApiServer): ProviderMachine => ({
	providerServerId: String(server.id),
	providerLabel: server.name,
	powerState: server.status === "off" ? "off" : "running",
});

export const HETZNER_API_BASE_URL = "https://api.hetzner.cloud/v1";
export const HETZNER_PROVIDER_ID = "hetzner" as const;
export const HETZNER_LEGACY_PROVIDER_ID = "cloud-api" as const;

export const makeHetznerMachineProvider = (
	config: HetznerMachineConfig,
	http: HetznerHttpClient = { fetch: globalThis.fetch },
): MachineProviderAdapter => {
	const apiBaseUrl = (config.apiBaseUrl ?? HETZNER_API_BASE_URL).replace(
		/\/+$/,
		"",
	);

	const request = <A, I>(
		method: string,
		path: string,
		schema: Schema.Codec<A, I>,
		body?: unknown,
	): Effect.Effect<A, MachineProviderError> =>
		Effect.tryPromise({
			try: () =>
				http.fetch(`${apiBaseUrl}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${Redacted.value(config.accessToken)}`,
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			catch: () => providerError("transient"),
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.tryPromise({
							try: (): Promise<unknown> => response.json(),
							catch: () => providerError("transient"),
						})
					: Effect.fail(errorForStatus(response.status)),
			),
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
			Effect.mapError((error) =>
				error instanceof MachineProviderError
					? error
					: providerError("transient"),
			),
		);

	const requestVoid = (
		method: string,
		path: string,
		body?: unknown,
		notFoundIsSuccess = false,
	): Effect.Effect<void, MachineProviderError> =>
		Effect.tryPromise({
			try: () =>
				http.fetch(`${apiBaseUrl}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${Redacted.value(config.accessToken)}`,
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			catch: () => providerError("transient"),
		}).pipe(
			Effect.flatMap((response) =>
				response.ok || (notFoundIsSuccess && response.status === 404)
					? Effect.void
					: Effect.fail(errorForStatus(response.status)),
			),
		);

	const ensureBackups = (
		server: ApiServer,
	): Effect.Effect<ApiServer, MachineProviderError> =>
		server.backup_window !== null && server.backup_window !== undefined
			? Effect.succeed(server)
			: requestVoid("POST", `/servers/${server.id}/actions/enable_backup`).pipe(
					Effect.as(server),
				);

	const recoverByLabel = (
		providerLabel: string,
	): Effect.Effect<ProviderMachine | null, MachineProviderError> =>
		request(
			"GET",
			`/servers?name=${encodeURIComponent(providerLabel)}`,
			ServerListResponse,
		).pipe(
			Effect.flatMap((response) => {
				const server = response.servers.find(
					(candidate) => candidate.name === providerLabel,
				);
				return server === undefined
					? Effect.succeed(null)
					: ensureBackups(server).pipe(Effect.map(toProviderMachine));
			}),
		);

	return {
		providerId: HETZNER_PROVIDER_ID,
		create: Effect.fn("HetznerMachineProvider.create")(function* (input) {
			const profile = config.offerProfiles[input.offer.offerId];
			if (profile === undefined) {
				return yield* providerError("rejected");
			}
			const serverTypes = yield* request(
				"GET",
				`/server_types?name=${encodeURIComponent(profile.serverType)}`,
				ServerTypeListResponse,
			);
			const serverType = serverTypes.server_types.find(
				(candidate) => candidate.name === profile.serverType,
			);
			const locationAvailable = serverType?.locations.some(
				(location) => location.name === profile.location && location.available,
			);
			const architectureMatches =
				serverType?.architecture === "x86" ||
				serverType?.architecture === input.offer.architecture;
			if (
				serverType === undefined ||
				serverType.cores !== input.offer.vcpuCount ||
				serverType.memory * 1_024 !== input.offer.memoryMib ||
				serverType.disk < input.offer.diskGib ||
				!architectureMatches ||
				!locationAvailable
			) {
				return yield* providerError("rejected");
			}
			const response = yield* request("POST", "/servers", ServerResponse, {
				name: input.providerLabel,
				server_type: profile.serverType,
				image: profile.image,
				location: profile.location,
				user_data: config.renderUserData(input),
				start_after_create: true,
				automount: false,
				public_net: {
					enable_ipv4: true,
					enable_ipv6: true,
				},
				firewalls: [{ firewall: profile.firewallId }],
				labels: {
					"zuse-machine-id": input.machineId,
				},
			});
			const server = yield* ensureBackups(response.server);
			return toProviderMachine(server);
		}),
		recoverByLabel,
		inspect: (providerServerId) =>
			request("GET", `/servers/${providerServerId}`, ServerResponse).pipe(
				Effect.flatMap((response) => ensureBackups(response.server)),
				Effect.map((server) => toProviderMachine(server)),
				Effect.catchTag("MachineProviderError", (error) =>
					error.code === "not-found"
						? Effect.succeed(null)
						: Effect.fail(error),
				),
			),
		powerOff: (providerServerId) =>
			requestVoid("POST", `/servers/${providerServerId}/actions/poweroff`),
		powerOn: (providerServerId) =>
			requestVoid("POST", `/servers/${providerServerId}/actions/poweron`),
		snapshot: (providerServerId, label) =>
			request(
				"POST",
				`/servers/${providerServerId}/actions/create_image`,
				SnapshotResponse,
				{
					type: "snapshot",
					description: label,
					labels: { "zuse-snapshot-kind": "final" },
				},
			).pipe(Effect.map((response) => String(response.image.id))),
		delete: (providerServerId) =>
			requestVoid("DELETE", `/servers/${providerServerId}`, undefined, true),
		deleteSnapshot: (snapshotId) =>
			requestVoid("DELETE", `/images/${snapshotId}`, undefined, true),
	};
};
