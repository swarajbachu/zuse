import { type Effect, type Layer, ManagedRuntime, type Scope } from "effect";

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
