import { Data, Effect, type Layer, ManagedRuntime, Scope } from "effect";
import { RpcClient, type RpcGroup } from "effect/unstable/rpc";
import type { Rpc } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export type ConnectionOptions = {
	readonly key: string;
	readonly endpoint: string;
	readonly token?: string | null;
};

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
}> {}

export type VersionHandshake<Client, Error> = {
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
): Promise<ClientSession<Client>> => {
	const runtime = ManagedRuntime.make(layer);
	try {
		const client = await runtime.runPromise(makeClient(runtime.scope));
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
) =>
	makeManagedClientSession(layer, (scope) =>
		Effect.gen(function* () {
			const client = yield* RpcClient.make(group).pipe(
				Effect.provideService(Scope.Scope, scope),
			);
			if (handshake !== undefined) {
				const welcome = yield* handshake.perform(client, {
					protocolVersion: handshake.protocolVersion,
				});
				yield* validateProtocolVersion(
					handshake.protocolVersion,
					welcome.protocolVersion,
				);
			}
			return client;
		}),
	);
