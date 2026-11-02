import {
	isRpcCredentialExpired,
	makeRpcClientSession,
} from "@zuse/client-runtime/connection";
import {
	grantRouteEndpoints,
	raceConnectionRoutes,
} from "@zuse/client-runtime/connection-routes";
import type { EnvironmentWakeIntent } from "@zuse/client-runtime/environment-runtime";
import {
	type ConnectionHealth,
	type ConnectionSnapshot,
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import type { RpcClient, RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { captureMobileAnalytics } from "../lib/analytics";
import { createConnectionTelemetry } from "../lib/connection-telemetry";
import { verifyPinnedLocalServer } from "../lib/nearby-pairing";
import { connectEnvironment } from "./api-client";
import {
	connectCloudRuntime,
	markCloudGatewayHealthy,
	requestCloudRuntimeWake,
} from "./cloud-runtime";
import {
	logConnectionDiagnostic,
	logConnectionProblem,
} from "./connection-diagnostics";
import {
	isIntentionalConnectionInterruption,
	isRetryableClientError,
} from "./connection-failures";
import { ConnectionFailed } from "./errors";
import { makeMobileWebSocket } from "./mobile-websocket";
import { type WsProtocolOptions, wsClientProtocolLayer } from "./ws-protocol";

export type MemoizeClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	RpcClientError
>;

export type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";

const runtimeKey = (options: WsProtocolOptions) =>
	options.key ??
	options.environmentId ??
	`${options.wsBaseUrl ?? `${options.host}:${options.port}`}`;

type PreparedOptions = WsProtocolOptions & {
	readonly cloudProtocols?: readonly string[];
	readonly routes?: readonly string[];
};
const makeClientSession = async (
	options: PreparedOptions,
	signal?: AbortSignal,
): Promise<{ client: MemoizeClient; dispose: () => Promise<void> }> => {
	if (options.routes) {
		const result = await raceConnectionRoutes(
			options.routes,
			(url, signal) =>
				makeClientSession(
					{ ...options, wsBaseUrl: url, routes: undefined },
					signal,
				),
			{ signal },
		);
		return result.session;
	}
	logConnectionDiagnostic("runtime.create", {
		key: runtimeKey(options),
		api: options.environmentId !== undefined,
		wsBaseUrl: options.wsBaseUrl ?? null,
		host: options.host,
		port: options.port,
		hasToken: options.token !== undefined && options.token !== null,
	});
	const protocolLayer = wsClientProtocolLayer(options, {
		openTimeout: "25 seconds",
		makeWebSocket: makeMobileWebSocket,
		supervised: true,
		protocols: options.cloudProtocols,
	}).pipe(Layer.orDie);
	const session = await makeRpcClientSession(
		protocolLayer,
		MemoizeRpcs,
		{
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		},
		signal,
	);
	try {
		if (options.environmentId && !options.cloudWorkspaceId) {
			const descriptor = await Effect.runPromise(
				session.client["connect.describe"](),
				{ signal },
			);
			if (descriptor.environmentId !== options.environmentId)
				throw new Error("This route belongs to another computer. Pair again.");
		}
		return session;
	} catch (cause) {
		await session.dispose();
		throw cause;
	}
};

const prepareOptions = async (
	options: WsProtocolOptions,
): Promise<PreparedOptions> => {
	logConnectionDiagnostic("runtime.prepare", {
		key: runtimeKey(options),
		host: options.host,
		port: options.port,
		verifyIdentity: options.serverKeyPin !== undefined,
		refreshAccountGrant: options.refreshAccountGrant === true,
	});
	if (options.cloudWorkspaceId !== undefined) {
		const ticket = await connectCloudRuntime(options.cloudWorkspaceId);
		return {
			...options,
			wsBaseUrl: ticket.wsUrl,
			token: null,
			cloudProtocols: [ticket.protocol, ticket.credential],
		};
	}
	if (
		options.serverPublicKey !== undefined &&
		options.serverKeyPin !== undefined
	) {
		await verifyPinnedLocalServer({
			host: options.host,
			port: options.port,
			publicKey: options.serverPublicKey,
			pin: options.serverKeyPin,
		});
	}
	if (
		options.refreshAccountGrant !== true ||
		options.environmentId === undefined
	) {
		return options;
	}
	logConnectionDiagnostic("api.connect_grant.start", {
		key: runtimeKey(options),
		environmentId: options.environmentId,
	});
	const grant = await connectEnvironment(options.environmentId);
	logConnectionDiagnostic("api.connect_grant.ok", {
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
		routes: grantRouteEndpoints(grant).map((endpoint) => endpoint.wsBaseUrl),
	};
};

const recordConnectionTelemetry = createConnectionTelemetry();

const supervisor = createConnectionSupervisor<WsProtocolOptions, MemoizeClient>(
	{
		keyOf: runtimeKey,
		maxAutomaticAttempts: (options) =>
			options.cloudWorkspaceId ? 2 : Number.POSITIVE_INFINITY,
		prepareOptions,
		createClient: makeClientSession,
		validateClient: async (client) => {
			const descriptor = await Effect.runPromise(client["connect.describe"]());
			markCloudGatewayHealthy(
				descriptor.environmentId,
				descriptor.capabilities,
			);
		},
		// Sockets are probed on resume instead of closed in the background, so
		// mobile has no platform offline edge; failures drive recovery.
		isOnline: () => true,
		shouldReconnectOnOptionsChange: (previous, next) =>
			previous.host !== next.host ||
			previous.port !== next.port ||
			previous.wsBaseUrl !== next.wsBaseUrl ||
			previous.token !== next.token ||
			previous.environmentId !== next.environmentId ||
			previous.routeGeneration !== next.routeGeneration,
		schedule: (delayMs, fn) => {
			const timer = setTimeout(fn, delayMs);
			return () => clearTimeout(timer);
		},
		onDiagnostic: ({ event, key, details }) => {
			logConnectionDiagnostic(`supervisor.${event}`, { key, ...details });
			const telemetry = recordConnectionTelemetry(
				`supervisor.${event}`,
				key,
				details,
				supervisor.optionsList().find((options) => runtimeKey(options) === key),
			);
			if (telemetry !== null)
				captureMobileAnalytics(telemetry.name, telemetry.properties);
		},
		confirmFailuresWithProbe: true,
		isRetryableCommandError: isRetryableClientError,
		isIgnorableFailure: isIntentionalConnectionInterruption,
	},
);

const connectionEntry = (
	options: WsProtocolOptions,
): ConnectionSupervisorEntry<MemoizeClient> => supervisor.get(options);

export const getConnectionClient = (
	options: WsProtocolOptions,
	wake = true,
	wakeIntent?: EnvironmentWakeIntent,
): Effect.Effect<MemoizeClient, ConnectionFailed> =>
	Effect.suspend(() => {
		if (
			wake &&
			options.cloudWorkspaceId !== undefined &&
			getConnectionSnapshot(options).status !== "connected"
		)
			requestCloudRuntimeWake(options.cloudWorkspaceId, wakeIntent);
		return connectionEntry(options)
			.getClient()
			.pipe(
				Effect.mapError(
					(cause) => new ConnectionFailed({ message: cause.message }),
				),
			);
	});

export const disposeConnection = (options: WsProtocolOptions): Promise<void> =>
	connectionEntry(options).remove();

export const reportConnectionFailure = (
	options: WsProtocolOptions,
	cause: unknown,
): void => {
	if (
		isIntentionalConnectionInterruption(cause) ||
		!isRetryableClientError(cause)
	) {
		return;
	}
	logConnectionProblem("runtime.report_failure", {
		key: runtimeKey(options),
		reason: cause instanceof Error ? cause.message : String(cause),
	});
	// Expiry is definitive; replace at once instead of probing a socket whose
	// requests will keep failing with the same stale grant.
	if (isRpcCredentialExpired(cause)) connectionEntry(options).replaceSession();
	else connectionEntry(options).reportFailure(cause);
};

export const retryConnectionNow = (options: WsProtocolOptions): void => {
	connectionEntry(options).retryNow();
};

/**
 * Push updated options into the supervisor without waiting for a screen to
 * re-subscribe. When the route changed (host/port/routeGeneration), the
 * supervisor reconnects immediately — this is how the connectivity runtime
 * wakes an exhausted entry the moment a fresh local route lands.
 */
export const applyConnectionOptions = (options: WsProtocolOptions): void => {
	connectionEntry(options);
};

export const subscribeConnection = (
	options: WsProtocolOptions,
	listener: (snapshot: ConnectionSnapshot) => void,
): (() => void) => connectionEntry(options).subscribe(listener);

/**
 * Probe every supervised connection after the app returns to the foreground.
 * Healthy sockets are kept; silent dead ones are replaced without a backoff.
 */
export const checkConnectionsHealth = (
	timeoutMs: number,
): Promise<
	readonly {
		readonly options: WsProtocolOptions;
		readonly health: ConnectionHealth;
	}[]
> => supervisor.checkHealth(timeoutMs);

/**
 * Replace supervised sessions after a long background: suspended apps often
 * lose sockets without a close event, so probing would only wait out a dead
 * socket. Returns the options of the replaced connections.
 */
export const replaceConnectionSessions = (
	filter: (options: WsProtocolOptions) => boolean,
): readonly WsProtocolOptions[] => supervisor.replaceSessions(filter);

/** Options of every supervised connection. */
export const supervisedConnectionOptions = (): readonly WsProtocolOptions[] =>
	supervisor.optionsList();

export const getConnectionSnapshot = (
	options: WsProtocolOptions,
): ConnectionSnapshot => connectionEntry(options).snapshot();
