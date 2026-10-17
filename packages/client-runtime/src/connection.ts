import {
	RpcAccessDeniedError,
	WIRE_PROTOCOL_VERSION,
	WireProtocolRejected,
} from "@zuse/contracts";
import {
	Data,
	Effect,
	type Layer,
	ManagedRuntime,
	Schema,
	Scope,
} from "effect";
import type { Rpc } from "effect/unstable/rpc";
import { RpcClient, type RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { withRuntimeRpcCompatibility } from "./legacy-runtime-capabilities.ts";

export type ConnectionOptions = {
	readonly key: string;
	readonly endpoint: string;
	readonly token?: string | null;
};

/** Expiry can recover with a fresh connection grant; permission denial cannot. */
export const isRpcCredentialExpired = (cause: unknown): boolean =>
	Schema.is(RpcAccessDeniedError)(cause) && cause.code === "credential-expired";

/** A confirmed permission denial invalidates cached data, unlike transport loss. */
export const isRpcAccessDenied = (cause: unknown): boolean =>
	Schema.is(RpcAccessDeniedError)(cause) && cause.code === "access-denied";

export type ClientSession<Client> = {
	readonly client: Client;
	readonly dispose: () => Promise<void>;
};

export type ClientConnector<Options extends ConnectionOptions, Client> = (
	options: Options,
) => Promise<ClientSession<Client>>;

export class WireProtocolMismatchError extends Data.TaggedError(
	"WireProtocolMismatchError",
)<{
	readonly expectedVersion: number;
	readonly receivedVersion: number;
}> {
	override get message() {
		return `Update required: this app uses protocol ${this.expectedVersion}, but this runtime uses ${this.receivedVersion}. Update Zuse or the workspace runtime before reconnecting.`;
	}
}

const clientProtocolVersion = Symbol("zuse.clientProtocolVersion");

/** The confirmed handshake version, never an inferred version from a network error. */
export const getClientProtocolVersion = (
	client: object,
): number | undefined => {
	const value: unknown = Reflect.get(client, clientProtocolVersion);
	return typeof value === "number" ? value : undefined;
};

export type VersionHandshake<Client, Error> = {
	/** Only gateway transports may negotiate retained cloud contracts. */
	readonly allowLegacyCloud?: boolean;
	readonly onNegotiated?: (version: number) => void;
	readonly protocolVersion: number;
	readonly perform: (
		client: Client,
		hello: { readonly protocolVersion: number },
	) => Effect.Effect<{ readonly protocolVersion: number }, Error>;
};

export const validateProtocolVersion = (
	expectedVersion: number,
	receivedVersion: number,
): Effect.Effect<void, WireProtocolMismatchError> =>
	expectedVersion === receivedVersion
		? Effect.void
		: Effect.fail(
				new WireProtocolMismatchError({
					expectedVersion,
					receivedVersion,
				}),
			);

export const withWireProtocolVersion = (
	url: string,
	protocolVersion: number,
): string => {
	const parsed = new URL(url);
	parsed.searchParams.set("wireVersion", String(protocolVersion));
	return parsed.toString();
};

/**
 * Own the Effect runtime and scope behind a client connection. Transport
 * adapters supply only their protocol layer and scoped client constructor.
 */
export const makeManagedClientSession = async <
	Requirements,
	LayerError,
	Client,
	ClientError,
>(
	layer: Layer.Layer<Requirements, LayerError>,
	makeClient: (
		scope: Scope.Scope,
	) => Effect.Effect<Client, ClientError, Requirements>,
	signal?: AbortSignal,
): Promise<ClientSession<Client>> => {
	const runtime = ManagedRuntime.make(layer);
	try {
		const client = await runtime.runPromise(makeClient(runtime.scope), {
			signal,
		});
		return { client, dispose: () => runtime.dispose() };
	} catch (cause) {
		await runtime.dispose();
		throw cause;
	}
};

/** Build a scoped Effect RPC client without exposing runtime scope to apps. */
export const makeRpcClientSession = <
	Rpcs extends Rpc.Any,
	LayerError,
	HandshakeError = never,
>(
	layer: Layer.Layer<
		RpcClient.Protocol | Exclude<Rpc.MiddlewareClient<Rpcs>, Scope.Scope>,
		LayerError
	>,
	group: RpcGroup.RpcGroup<Rpcs>,
	handshake?: VersionHandshake<
		RpcClient.RpcClient<Rpcs, RpcClientError>,
		HandshakeError
	>,
	signal?: AbortSignal,
) =>
	makeManagedClientSession(
		layer,
		(scope) =>
			Effect.gen(function* () {
				const client = yield* RpcClient.make(group).pipe(
					Effect.provideService(Scope.Scope, scope),
				);
				if (handshake !== undefined) {
					const attempt = (version: number) =>
						handshake
							.perform(client, { protocolVersion: version })
							.pipe(
								Effect.flatMap((welcome) =>
									validateProtocolVersion(
										version,
										welcome.protocolVersion,
									).pipe(Effect.as(welcome)),
								),
							);
					const welcome = yield* attempt(handshake.protocolVersion).pipe(
						Effect.catch((cause) => {
							if (
								handshake.allowLegacyCloud === true &&
								handshake.protocolVersion === WIRE_PROTOCOL_VERSION &&
								Schema.is(WireProtocolRejected)(cause) &&
								cause.receivedVersion === handshake.protocolVersion &&
								(cause.expectedVersion === 5 || cause.expectedVersion === 6)
							)
								return attempt(cause.expectedVersion);
							return Effect.fail(cause);
						}),
						// Opening a gateway socket does not establish a working runtime.
						// Bound the full negotiation so a silent peer releases the scoped
						// transport and returns control to the connection supervisor.
						Effect.timeout("30 seconds"),
					);
					Object.defineProperty(client, clientProtocolVersion, {
						value: welcome.protocolVersion,
					});
					handshake.onNegotiated?.(welcome.protocolVersion);
					return withRuntimeRpcCompatibility(client, welcome.protocolVersion);
				}
				return client;
			}),
		signal,
	);
