import {
	type ConnectionSnapshot,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
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

const makeRuntime = (options: WsProtocolOptions) => {
	logConnectionDiagnostic("runtime.create", {
		key: runtimeKey(options),
		relay: options.environmentId !== undefined,
		wsBaseUrl: options.wsBaseUrl ?? null,
		host: options.host,
		port: options.port,
		hasToken: options.token !== undefined && options.token !== null,
	});
	const protocolLayer = wsClientProtocolLayer(options).pipe(Layer.orDie);
	const runtime = ManagedRuntime.make(protocolLayer);
	const client = runtime.runPromise(
		RpcClient.make(MemoizeRpcs).pipe(
			Effect.provideService(Scope.Scope, runtime.scope),
		),
	);
	return { runtime, client };
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
		createClient: async (options) => {
			const runtime = makeRuntime(options);
			return {
				client: await runtime.client,
				dispose: () => runtime.runtime.dispose(),
			};
		},
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

export const getConnectionClient = (
	options: WsProtocolOptions,
): Effect.Effect<MemoizeClient, ConnectionFailed> =>
	supervisor
		.get(options)
		.getClient()
		.pipe(
			Effect.mapError(
				(cause) => new ConnectionFailed({ message: cause.message }),
			),
		);

export const disposeConnection = (
	options: WsProtocolOptions,
): Promise<void> => {
	return supervisor.get(options).remove();
};

export const reportConnectionFailure = (
	options: WsProtocolOptions,
	cause: unknown,
): void => {
	logConnectionProblem("runtime.report_failure", {
		key: runtimeKey(options),
		reason: cause instanceof Error ? cause.message : String(cause),
	});
	supervisor.get(options).reportFailure(cause);
};

export const retryConnectionNow = (options: WsProtocolOptions): void => {
	supervisor.get(options).retryNow();
};

export const subscribeConnection = (
	options: WsProtocolOptions,
	listener: (snapshot: ConnectionSnapshot) => void,
): (() => void) => supervisor.get(options).subscribe(listener);

export const setConnectionOnline = (online: boolean): void => {
	logConnectionDiagnostic("runtime.online_set", { online });
	currentOnline = online;
	supervisor.setOnline(online);
};

export const getConnectionSnapshot = (
	options: WsProtocolOptions,
): ConnectionSnapshot => supervisor.get(options).snapshot();
