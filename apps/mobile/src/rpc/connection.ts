import { CommandDispatcher } from "@zuse/client-runtime/command-dispatch";
import { makeRpcClientSession } from "@zuse/client-runtime/connection";
import {
	type ConnectionSnapshot,
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { RpcClient, type RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
	logConnectionDiagnostic,
	logConnectionProblem,
} from "./connection-diagnostics";
import { ConnectionFailed } from "./errors";
import { connectEnvironment } from "./relay-client";
import { type WsProtocolOptions, wsClientProtocolLayer } from "./ws-protocol";

type MemoizeClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	RpcClientError
>;

export type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";

const runtimeKey = (options: WsProtocolOptions) =>
	options.key ??
	options.environmentId ??
	`${options.wsBaseUrl ?? `${options.host}:${options.port}`}`;

const makeClientSession = (options: WsProtocolOptions) => {
	logConnectionDiagnostic("runtime.create", {
		key: runtimeKey(options),
		relay: options.environmentId !== undefined,
		wsBaseUrl: options.wsBaseUrl ?? null,
		host: options.host,
		port: options.port,
		hasToken: options.token !== undefined && options.token !== null,
	});
	const protocolLayer = wsClientProtocolLayer(options).pipe(Layer.orDie);
	return makeRpcClientSession(protocolLayer, MemoizeRpcs, {
		protocolVersion: WIRE_PROTOCOL_VERSION,
		perform: (client, hello) => client["connect.handshake"](hello),
	});
};

const prepareOptions = async (
	options: WsProtocolOptions,
): Promise<WsProtocolOptions> => {
	if (options.environmentId === undefined || options.wsBaseUrl === undefined) {
		return options;
	}
	logConnectionDiagnostic("relay.connect_grant.start", {
		key: runtimeKey(options),
		environmentId: options.environmentId,
	});
	const grant = await connectEnvironment(options.environmentId);
	logConnectionDiagnostic("relay.connect_grant.ok", {
		key: runtimeKey(options),
		environmentId: options.environmentId,
		wsBaseUrl: grant.endpoint.wsBaseUrl,
		expiresAt: grant.expiresAt,
	});
	return {
		...options,
		host: new URL(grant.endpoint.wsBaseUrl).hostname,
		port:
			Number(new URL(grant.endpoint.wsBaseUrl).port) ||
			(grant.endpoint.wsBaseUrl.startsWith("wss:") ? 443 : 80),
		wsBaseUrl: grant.endpoint.wsBaseUrl,
		token: grant.connectToken,
	};
};

const supervisor = createConnectionSupervisor<WsProtocolOptions, MemoizeClient>(
	{
		keyOf: runtimeKey,
		prepareOptions,
		createClient: makeClientSession,
		validateClient: (client) =>
			Effect.runPromise(client["connect.describe"]().pipe(Effect.asVoid)),
		isOnline: () => currentOnline,
		schedule: (delayMs, fn) => {
			const timer = setTimeout(fn, delayMs);
			return () => clearTimeout(timer);
		},
		onDiagnostic: ({ event, key, details }) => {
			logConnectionDiagnostic(`supervisor.${event}`, { key, ...details });
		},
	},
);

let currentOnline = true;

type ConnectionState = {
	readonly entry: ConnectionSupervisorEntry<MemoizeClient>;
	readonly dispatcher: CommandDispatcher;
	unsubscribe: () => void;
	generation: number;
};

const connectionStates = new Map<string, ConnectionState>();

const connectionState = (options: WsProtocolOptions): ConnectionState => {
	const key = runtimeKey(options);
	const existing = connectionStates.get(key);
	if (existing !== undefined) {
		supervisor.get(options);
		return existing;
	}
	const entry = supervisor.get(options);
	const dispatcher = new CommandDispatcher();
	const state: ConnectionState = {
		entry,
		dispatcher,
		generation: 0,
		unsubscribe: () => undefined,
	};
	const unsubscribe = entry.subscribe((snapshot) => {
		if (
			snapshot.status === "connected" &&
			state.generation > 0 &&
			snapshot.generation > state.generation
		) {
			dispatcher.redispatchPending();
		}
		state.generation = Math.max(state.generation, snapshot.generation);
	});
	state.unsubscribe = unsubscribe;
	connectionStates.set(key, state);
	return state;
};

const isRetryableClientError = (cause: unknown): boolean =>
	(cause instanceof ConnectionFailed && cause.message !== "offline") ||
	(typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		cause._tag === "RpcClientError");

export const getConnectionClient = (
	options: WsProtocolOptions,
): Effect.Effect<MemoizeClient, ConnectionFailed> =>
	connectionState(options)
		.entry.getClient()
		.pipe(
			Effect.mapError(
				(cause) => new ConnectionFailed({ message: cause.message }),
			),
		);

export const disposeConnection = (
	options: WsProtocolOptions,
): Promise<void> => {
	const key = runtimeKey(options);
	const state = connectionStates.get(key);
	if (state === undefined) return supervisor.get(options).remove();
	connectionStates.delete(key);
	state.unsubscribe();
	state.dispatcher.failPending(new Error("connection disposed"));
	return state.entry.remove();
};

export const reportConnectionFailure = (
	options: WsProtocolOptions,
	cause: unknown,
): void => {
	logConnectionProblem("runtime.report_failure", {
		key: runtimeKey(options),
		reason: cause instanceof Error ? cause.message : String(cause),
	});
	connectionState(options).entry.reportFailure(cause);
};

export const retryConnectionNow = (options: WsProtocolOptions): void => {
	connectionState(options).entry.retryNow();
};

export const subscribeConnection = (
	options: WsProtocolOptions,
	listener: (snapshot: ConnectionSnapshot) => void,
): (() => void) => connectionState(options).entry.subscribe(listener);

export const setConnectionOnline = (online: boolean): void => {
	logConnectionDiagnostic("runtime.online_set", { online });
	currentOnline = online;
	supervisor.setOnline(online);
};

export const getConnectionSnapshot = (
	options: WsProtocolOptions,
): ConnectionSnapshot => connectionState(options).entry.snapshot();

export const dispatchRetryableConnectionCommand = <A>(
	options: WsProtocolOptions,
	commandId: string,
	operation: (client: MemoizeClient) => Effect.Effect<A, unknown>,
): Effect.Effect<A, ConnectionFailed> =>
	Effect.tryPromise({
		try: () =>
			connectionState(options).dispatcher.dispatch(
				commandId,
				async () => {
					try {
						const client = await Effect.runPromise(
							getConnectionClient(options),
						);
						return await Effect.runPromise(operation(client));
					} catch (cause) {
						if (isRetryableClientError(cause)) {
							reportConnectionFailure(options, cause);
						}
						throw cause;
					}
				},
				{ shouldRetry: isRetryableClientError },
			),
		catch: (cause) =>
			cause instanceof ConnectionFailed
				? cause
				: new ConnectionFailed({
						message: cause instanceof Error ? cause.message : String(cause),
					}),
	});
