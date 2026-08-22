import {
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import { parseEnvironmentRoute } from "@zuse/client-runtime/environment-scope";
import {
	type ConnectionSnapshot,
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
	defaultClassifyError,
} from "@zuse/client-runtime/supervisor";
import type { WebSocketCloseInfo } from "@zuse/client-runtime/ws-protocol";
import {
	type CloudWorkspaceConnection,
	MemoizeRpcs,
	WIRE_PROTOCOL_VERSION,
	WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	type RpcClient,
	type RpcGroup,
	RpcSerialization,
} from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { RpcBridge } from "./bridge.ts";
import { requestBrowserWebSocketUrl } from "./browser-session.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import { electronClientProtocolLayer } from "./electron-client-protocol.ts";
import {
	LOCAL_RENDERER_STORAGE_SCOPE,
	setActiveEnvironmentStorageScope,
} from "./renderer-environment-scope.ts";
import { instrumentRendererRpcClient } from "./rpc-stall-instrumentation.ts";
import { wsClientProtocolLayer } from "./ws-client-protocol.ts";

export type MemoizeClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	RpcClientError
>;

type RendererConnectionOptions =
	| {
			readonly key: string;
			readonly kind: "electron";
			readonly bridge: RpcBridge;
	  }
	| {
			readonly key: string;
			readonly kind: "websocket";
			readonly wsUrl: string;
			readonly protocols?: ReadonlyArray<string>;
			readonly refreshWsUrl?: () => Promise<string>;
			readonly refreshConnection?: () => Promise<CloudWorkspaceConnection>;
	  };

export type RendererRpcSession = Readonly<{
	client: MemoizeClient;
	dispose: () => Promise<void>;
}>;

type PreparedRendererSession = Readonly<{
	key: string;
	create: (
		onClose: (close: WebSocketCloseInfo) => void,
	) => Promise<RendererRpcSession>;
}>;

export type PassiveRendererSessionHooks = Readonly<{
	prepare: (environmentId: string) => Promise<PreparedRendererSession>;
	invalidateCloudTicket: (workspaceId: string) => void;
}>;

export const LOCAL_ENVIRONMENT_KEY = "local";

const environmentConnections = new Map<string, RendererConnectionOptions>();
type CloudWorkspaceRegistration = {
	connection: CloudWorkspaceConnection | null;
	refresh: () => Promise<CloudWorkspaceConnection>;
	readonly refreshStable: () => Promise<CloudWorkspaceConnection>;
};
const cloudWorkspaceRegistrations = new Map<
	string,
	CloudWorkspaceRegistration
>();
const cloudWorkspaceRuntimeRecoveryCommands = new Map<string, string>();
const cloudWorkspaceAbnormalCloseCounts = new Map<string, number>();
const cloudWorkspaceHealthyConnections = new Set<string>();

const invalidateCloudWorkspaceTicket = (workspaceId: string): void => {
	const registration = cloudWorkspaceRegistrations.get(workspaceId);
	if (registration !== undefined) registration.connection = null;
};

/** Queue one idempotent resume/reconcile when the provider confirms runtime loss. */
export const requestCloudWorkspaceRuntimeRecovery = (
	workspaceId: string,
): void => {
	invalidateCloudWorkspaceTicket(workspaceId);
	if (!cloudWorkspaceRuntimeRecoveryCommands.has(workspaceId)) {
		cloudWorkspaceRuntimeRecoveryCommands.set(workspaceId, crypto.randomUUID());
	}
};

const recordCloudWorkspaceGatewayClose = (
	workspaceId: string,
	close: Pick<WebSocketCloseInfo, "code">,
): void => {
	const runtimeMissing =
		close.code === WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code;
	const abnormalCloseCount =
		close.code === 1006
			? (cloudWorkspaceAbnormalCloseCounts.get(workspaceId) ?? 0) + 1
			: 0;
	if (abnormalCloseCount === 0)
		cloudWorkspaceAbnormalCloseCounts.delete(workspaceId);
	else cloudWorkspaceAbnormalCloseCounts.set(workspaceId, abnormalCloseCount);
	// Cloudflare may surface an immediate Durable Object close as browser code
	// 1006 instead of preserving the gateway's private 4100 code. Before the
	// first successful handshake, recover immediately: retrying the same absent
	// runtime only adds a full reconnect cycle. Once this registration has been
	// healthy, retain one retry so an ordinary network flap does not restart it.
	const missingBeforeFirstHandshake =
		close.code === 1006 && !cloudWorkspaceHealthyConnections.has(workspaceId);
	if (
		runtimeMissing ||
		missingBeforeFirstHandshake ||
		abnormalCloseCount >= 2
	) {
		requestCloudWorkspaceRuntimeRecovery(workspaceId);
	}
};

export const markCloudWorkspaceConnectionHealthy = (
	workspaceId: string,
): void => {
	cloudWorkspaceAbnormalCloseCounts.delete(workspaceId);
	cloudWorkspaceHealthyConnections.add(workspaceId);
};

export const cloudWorkspaceRequiresRuntimeRecovery = (
	workspaceId: string,
): boolean => cloudWorkspaceRuntimeRecoveryCommands.has(workspaceId);

export const cloudWorkspaceRuntimeRecoveryCommandId = (
	workspaceId: string,
): string | undefined => cloudWorkspaceRuntimeRecoveryCommands.get(workspaceId);

export const clearCloudWorkspaceRuntimeRecovery = (
	workspaceId: string,
): void => {
	cloudWorkspaceRuntimeRecoveryCommands.delete(workspaceId);
};

/** Consume a missing-runtime signal before issuing the next one-time gateway
 * ticket. Recovery and ticket minting stay ordered inside the same retry so a
 * healthy-looking but detached relay record cannot cause a reconnect loop. */
export const refreshCloudWorkspaceConnectionWithRecovery = async (
	workspaceId: string,
	recover: (commandId: string) => Promise<void>,
	connect: () => Promise<CloudWorkspaceConnection>,
): Promise<CloudWorkspaceConnection> => {
	const recoveryCommandId = cloudWorkspaceRuntimeRecoveryCommandId(workspaceId);
	if (recoveryCommandId !== undefined) {
		try {
			await recover(recoveryCommandId);
		} catch (cause) {
			// A completed recovery can still end in a terminal startup failure. Its
			// command id remains a valid idempotency receipt, so replaying it can only
			// return that same failed workspace forever. Let the next missing-runtime
			// close mint one fresh recovery command.
			if (
				cloudWorkspaceRuntimeRecoveryCommandId(workspaceId) ===
				recoveryCommandId
			)
				clearCloudWorkspaceRuntimeRecovery(workspaceId);
			throw cause;
		}
	}
	const connection = await connect();
	if (
		recoveryCommandId !== undefined &&
		cloudWorkspaceRuntimeRecoveryCommandId(workspaceId) === recoveryCommandId
	)
		clearCloudWorkspaceRuntimeRecovery(workspaceId);
	return connection;
};
// Tickets last roughly a minute. Keep only a short safety margin so one live
// activation can reuse its freshly issued ticket without minting a second one.
const CLOUD_TICKET_REUSE_WINDOW_MS = 10_000;

export const canReuseCloudWorkspaceTicket = (
	connection: CloudWorkspaceConnection | null,
	nowMs = Date.now(),
): connection is CloudWorkspaceConnection =>
	connection !== null &&
	connection.expiresAt - nowMs > CLOUD_TICKET_REUSE_WINDOW_MS;
let activeEnvironmentId = LOCAL_ENVIRONMENT_KEY;
let localEnvironmentId = LOCAL_ENVIRONMENT_KEY;

const rendererConnectionKey = (): string => {
	if (typeof location === "undefined") return "environment:local";
	const route = parseEnvironmentRoute(location.pathname);
	return `environment:${route?.environmentId ?? "local"}`;
};

function resolveWebSocketUrl(): string {
	const env = (
		import.meta as { readonly env?: Record<string, string | undefined> }
	).env;
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return env?.VITE_ZUSE_WS_URL?.trim() || `${protocol}//${location.host}/rpc`;
}

const browserWebSocketOptions = () => ({
	wsUrl: resolveWebSocketUrl(),
	// Browser sessions authenticate the HTTP request with their cookie, then use
	// a fresh, single-use ticket for every WebSocket attempt. Refreshing here also
	// prevents reconnects from reusing a consumed ticket after the socket closes.
	refreshWsUrl: requestBrowserWebSocketUrl,
});

export function resolveRendererRpcTransportForTest(): {
	readonly kind: "electron" | "websocket";
	readonly wsUrl?: string;
	readonly refreshesWsUrl?: boolean;
} {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	if (bridge) return { kind: "electron" };
	const options = browserWebSocketOptions();
	return {
		kind: "websocket",
		wsUrl: options.wsUrl,
		refreshesWsUrl: options.refreshWsUrl !== undefined,
	};
}

const connectionOptions = (): RendererConnectionOptions => {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return bridge
		? { key: rendererConnectionKey(), kind: "electron", bridge: bridge.rpc }
		: {
				key: rendererConnectionKey(),
				kind: "websocket",
				...browserWebSocketOptions(),
			};
};

const optionsForEnvironment = (
	environmentId: string,
): RendererConnectionOptions => {
	const registered = environmentConnections.get(environmentId);
	if (registered !== undefined) return registered;
	if (environmentId !== LOCAL_ENVIRONMENT_KEY) {
		throw new Error(`Environment ${environmentId} is not connected.`);
	}
	return connectionOptions();
};

const prepareRendererConnectionOptions = async (
	options: RendererConnectionOptions,
): Promise<RendererConnectionOptions> => {
	if (options.kind !== "websocket") return options;
	if (options.refreshConnection !== undefined) {
		const connection = await options.refreshConnection();
		return {
			...options,
			wsUrl: connection.wsUrl,
			protocols: [connection.protocol, connection.credential],
		};
	}
	return options.refreshWsUrl === undefined
		? options
		: { ...options, wsUrl: await options.refreshWsUrl() };
};

let online = globalThis.navigator?.onLine ?? true;
export const RENDERER_WEBSOCKET_OPEN_TIMEOUT = "3 seconds" as const;

export const isIgnorableRendererFailure = (cause: unknown): boolean =>
	cause instanceof Error &&
	cause.message === "All fibers interrupted without error";

/**
 * Auth rejections carried as typed codes rather than message text. Tagged
 * errors like `CloudWorkspaceOpError` and `ConnectAuthError` often have empty
 * messages, so message-based classification alone would misread a rejected
 * credential as a transient failure and reconnect forever.
 */
export const isAuthCodedConnectionError = (cause: unknown): boolean => {
	if (typeof cause !== "object" || cause === null) return false;
	const coded = cause as { readonly code?: unknown; readonly reason?: unknown };
	return coded.code === "not-allowed" || coded.reason === "not-allowed";
};

const makeRendererRpcSession = async (
	options: RendererConnectionOptions,
	onClose: (event: WebSocketCloseInfo) => void,
): Promise<RendererRpcSession> => {
	const protocolLayer =
		options.kind === "electron"
			? electronClientProtocolLayer(options.bridge).pipe(
					Layer.provide(RpcSerialization.layerJson),
				)
			: wsClientProtocolLayer(
					withWireProtocolVersion(
						options.wsUrl || (await requestBrowserWebSocketUrl()),
						WIRE_PROTOCOL_VERSION,
					),
					{
						openTimeout: RENDERER_WEBSOCKET_OPEN_TIMEOUT,
						makeWebSocket:
							options.protocols === undefined
								? undefined
								: (url) =>
										new globalThis.WebSocket(url, [
											...(options.protocols ?? []),
										]),
						onClose,
					},
				);
	return instrumentRendererRpcClient(
		await makeRpcClientSession(protocolLayer, MemoizeRpcs, {
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		}),
	);
};

const supervisor = createConnectionSupervisor<
	RendererConnectionOptions,
	MemoizeClient
>({
	keyOf: (options) => options.key,
	prepareOptions: prepareRendererConnectionOptions,
	isOnline: () => online,
	isIgnorableFailure: isIgnorableRendererFailure,
	maxAutomaticAttempts: 6,
	schedule: (delayMs, reconnect) => {
		const timer = setTimeout(reconnect, delayMs);
		return () => clearTimeout(timer);
	},
	createClient: async (options) => {
		try {
			return await makeRendererRpcSession(options, (event) => {
				if (options.key.startsWith("workspace:")) {
					const workspaceId = options.key.slice("workspace:".length);
					invalidateCloudWorkspaceTicket(workspaceId);
					recordCloudWorkspaceGatewayClose(workspaceId, event);
				}
				reportRendererEntryFailure(
					options.key,
					new Error(
						`WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
					),
				);
			});
		} catch (cause) {
			// An HTTP rejection happens before WebSocket `close`, so the callback
			// above never gets a chance to invalidate its one-time credential.
			// Never let the supervisor retry the same rejected cloud ticket.
			if (options.key.startsWith("workspace:")) {
				const workspaceId = options.key.slice("workspace:".length);
				invalidateCloudWorkspaceTicket(workspaceId);
			}
			throw cause;
		}
	},
	isRetryableCommandError: isRpcClientTransportError,
	classifyError: (cause) =>
		isAuthCodedConnectionError(cause) ? "auth" : defaultClassifyError(cause),
	shouldReconnectOnOptionsChange: shouldReconnectRendererConnection,
	onDiagnostic: ({ event, key, details }) => {
		recordDiagnosticEvent({
			level:
				event.includes("failure") || event.includes("exhausted")
					? "warn"
					: "info",
			source: "connection.supervisor",
			message: event,
			detail: JSON.stringify({
				key,
				status: details?.status,
				attempt: details?.attempt,
				generation: details?.generation,
				delayMs: details?.delayMs,
				reason:
					typeof details?.reason === "string" &&
					/^WebSocket closed \(\d+\)\.$/u.test(details.reason)
						? details.reason
						: details?.reason === undefined
							? undefined
							: "connection failure",
			}),
		});
	},
});

export function shouldReconnectRendererConnection(
	previous: RendererConnectionOptions,
	next: RendererConnectionOptions,
): boolean {
	if (previous.kind !== next.kind) return true;
	if (previous.kind !== "websocket" || next.kind !== "websocket") return false;
	return (
		previous.wsUrl !== next.wsUrl ||
		previous.protocols?.join("\u0000") !== next.protocols?.join("\u0000") ||
		previous.refreshConnection !== next.refreshConnection
	);
}

const rendererEntries = new Map<
	string,
	ConnectionSupervisorEntry<MemoizeClient>
>();

const reportRendererEntryFailure = (key: string, cause: unknown): void => {
	for (const entry of rendererEntries.values()) {
		if (entry.snapshot().key === key) {
			entry.reportFailure(cause);
			return;
		}
	}
};

const getRendererEntry = (
	environmentId = activeEnvironmentId,
): ConnectionSupervisorEntry<MemoizeClient> => {
	const options = optionsForEnvironment(environmentId);
	const entry = supervisor.get(options);
	rendererEntries.set(environmentId, entry);
	return entry;
};

export function isRpcClientTransportError(cause: unknown): boolean {
	if (isIgnorableRendererFailure(cause)) return true;
	if (
		typeof cause !== "object" ||
		cause === null ||
		!("_tag" in cause) ||
		cause._tag !== "RpcClientError"
	)
		return false;
	const reason = "reason" in cause ? cause.reason : undefined;
	return !(
		typeof reason === "object" &&
		reason !== null &&
		"_tag" in reason &&
		reason._tag === "RpcClientDefect"
	);
}

export const getRpcClient = (environmentId?: unknown): Promise<MemoizeClient> =>
	Effect.runPromise(
		getRendererEntry(
			typeof environmentId === "string" ? environmentId : activeEnvironmentId,
		).getClient(),
	);

/**
 * Opens one passive physical RPC session for ClientBus. The session refreshes
 * route credentials before every acquisition, but deliberately owns no retry
 * timer or connection generation; EnvironmentRuntime is the sole lifecycle
 * and retry owner for this path.
 */
export const acquireRendererRpcSession = async (
	environmentId: string,
	options: Readonly<{
		onClose?: (cause: Error) => void;
		hooks?: PassiveRendererSessionHooks;
	}> = {},
): Promise<RendererRpcSession> => {
	const hooks =
		options.hooks ??
		({
			prepare: async (id) => {
				const prepared = await prepareRendererConnectionOptions(
					optionsForEnvironment(id),
				);
				return {
					key: prepared.key,
					create: (onClose) => makeRendererRpcSession(prepared, onClose),
				};
			},
			invalidateCloudTicket: invalidateCloudWorkspaceTicket,
		} satisfies PassiveRendererSessionHooks);
	const prepared = await hooks.prepare(environmentId);
	let active = true;
	return prepared
		.create((close) => {
			if (!active) return;
			if (prepared.key.startsWith("workspace:")) {
				const workspaceId = prepared.key.slice("workspace:".length);
				hooks.invalidateCloudTicket(workspaceId);
				recordCloudWorkspaceGatewayClose(workspaceId, close);
			}
			options.onClose?.(
				new Error(
					`WebSocket closed (${close.code}${close.reason ? `: ${close.reason}` : ""}).`,
				),
			);
		})
		.catch((cause) => {
			// HTTP 401/403 rejects the upgrade before `close` is observable. Clear
			// the cached ticket here so EnvironmentRuntime's next acquisition mints
			// a new credential instead of looping on the rejected one.
			if (active && prepared.key.startsWith("workspace:")) {
				hooks.invalidateCloudTicket(prepared.key.slice("workspace:".length));
			}
			throw cause;
		})
		.then((session) => {
			let disposed = false;
			return {
				client: session.client,
				dispose: async () => {
					if (disposed) return;
					disposed = true;
					active = false;
					await session.dispose();
				},
			};
		});
};

/**
 * Acquire a client and prove its socket is responsive before sending a
 * non-idempotent command. Dialogs can remain open across machine restarts or
 * multi-minute browser authorization flows.
 */
export const getVerifiedRpcClient = async (
	environmentId = activeEnvironmentId,
): Promise<MemoizeClient> => {
	let client = await getRpcClient(environmentId);
	try {
		await Effect.runPromise(
			client["ping.ping"]({}).pipe(Effect.timeout("5 seconds")),
		);
	} catch (cause) {
		reportRendererRpcFailure(cause, environmentId);
		retryRendererRpcConnection(environmentId);
		client = await getRpcClient(environmentId);
		await Effect.runPromise(
			client["ping.ping"]({}).pipe(Effect.timeout("5 seconds")),
		);
	}
	return client;
};

/**
 * Account and machine lifecycle operations always belong to the desktop that
 * owns this renderer, even while a project on another computer is active.
 */
export const getControlPlaneRpcClient = (): Promise<MemoizeClient> =>
	getRpcClient(localEnvironmentId);

export const registerWebSocketEnvironment = (
	environmentId: string,
	wsUrl: string,
): void => {
	environmentConnections.set(environmentId, {
		key: `environment:${environmentId}`,
		kind: "websocket",
		wsUrl,
	});
};

export const registerRelayEnvironment = (
	environmentId: string,
	initialWsUrl: string,
	refreshWsUrl: () => Promise<string>,
): void => {
	let initial: string | null = initialWsUrl;
	environmentConnections.set(environmentId, {
		key: `environment:${environmentId}`,
		kind: "websocket",
		wsUrl: initialWsUrl,
		refreshWsUrl: async () => {
			if (initial !== null) {
				const value = initial;
				initial = null;
				return value;
			}
			return refreshWsUrl();
		},
	});
};

/** Register a cloud workspace directly against its stable gateway route. */
export const registerCloudWorkspace = (
	workspaceId: string,
	initial: CloudWorkspaceConnection,
	refreshConnection: () => Promise<CloudWorkspaceConnection>,
): void => {
	const existingEntry = rendererEntries.get(workspaceId);
	let registration = cloudWorkspaceRegistrations.get(workspaceId);
	if (registration === undefined) {
		const created: CloudWorkspaceRegistration = {
			connection: initial,
			refresh: refreshConnection,
			refreshStable: async () => {
				const current = cloudWorkspaceRegistrations.get(workspaceId);
				if (current === undefined)
					throw new Error("Cloud workspace connection was removed.");
				if (canReuseCloudWorkspaceTicket(current.connection))
					return current.connection;
				const refreshed = await current.refresh();
				current.connection = refreshed;
				return refreshed;
			},
		};
		cloudWorkspaceRegistrations.set(workspaceId, created);
		registration = created;
		environmentConnections.set(workspaceId, {
			key: `workspace:${workspaceId}`,
			kind: "websocket",
			wsUrl: initial.wsUrl,
			protocols: [initial.protocol, initial.credential],
			refreshConnection: created.refreshStable,
		});
	} else {
		registration.refresh = refreshConnection;
		if (
			registration.connection === null ||
			initial.expiresAt > registration.connection.expiresAt
		)
			registration.connection = initial;
	}
	// Repeated live actions update the reusable ticket source but never replace
	// a connected or in-flight client. Only a terminal supervisor failure gets a
	// deliberate fresh-ticket retry.
	if (
		existingEntry !== undefined &&
		shouldRestartCloudWorkspaceConnection(existingEntry.snapshot().status)
	) {
		// `initial` was minted by the live action that reached this retry path.
		// Keep it so retryNow consumes that ticket instead of immediately minting
		// a second one. Genuine socket closes invalidate the ticket in onClose.
		existingEntry.retryNow();
	}
};

export const shouldRestartCloudWorkspaceConnection = (
	status: ConnectionSnapshot["status"],
): boolean => status === "error" || status === "blockedAuth";

export const registerLocalEnvironment = (environmentId: string): void => {
	localEnvironmentId = environmentId;
	environmentConnections.set(environmentId, connectionOptions());
};

export const setActiveEnvironment = (environmentId: string): void => {
	const options = optionsForEnvironment(environmentId);
	activeEnvironmentId = environmentId;
	setActiveEnvironmentStorageScope(
		options.kind === "electron" ? LOCAL_RENDERER_STORAGE_SCOPE : environmentId,
	);
};

export const getActiveEnvironment = (): string => activeEnvironmentId;

/**
 * The environment id of this physical desktop, registered once at catalog
 * initialize. Unlike the active environment it never changes afterwards —
 * it is the app's immutable frame of reference for "local vs remote".
 */
export const getLocalEnvironmentId = (): string => localEnvironmentId;

/** Whether this environment id belongs to a registered cloud workspace. */
export const isCloudWorkspaceEnvironment = (environmentId: string): boolean =>
	cloudWorkspaceRegistrations.has(environmentId);

export const removeRendererEnvironment = async (
	environmentId: string,
): Promise<void> => {
	environmentConnections.delete(environmentId);
	cloudWorkspaceRegistrations.delete(environmentId);
	cloudWorkspaceAbnormalCloseCounts.delete(environmentId);
	cloudWorkspaceHealthyConnections.delete(environmentId);
	cloudWorkspaceRuntimeRecoveryCommands.delete(environmentId);
	const entry = rendererEntries.get(environmentId);
	rendererEntries.delete(environmentId);
	if (activeEnvironmentId === environmentId)
		activeEnvironmentId = LOCAL_ENVIRONMENT_KEY;
	if (activeEnvironmentId === LOCAL_ENVIRONMENT_KEY) {
		setActiveEnvironmentStorageScope(LOCAL_RENDERER_STORAGE_SCOPE);
	}
	await entry?.remove();
};

export const reportRendererRpcFailure = (
	cause: unknown,
	environmentId = activeEnvironmentId,
): void => {
	getRendererEntry(environmentId).reportFailure(cause);
};

/** Report a long-lived stream failure once for the connection that owned it. */
export const reportRendererRpcStreamFailure = (
	generation: number,
	cause: unknown,
	environmentId = activeEnvironmentId,
): boolean => getRendererEntry(environmentId).reportFailure(cause, generation);

/**
 * Observe the shared renderer connection lifecycle. Long-lived RPC streams use
 * the generation edge to resubscribe without implementing their own retry loop
 * or bypassing the supervisor's bounded exponential backoff.
 */
export const subscribeRendererRpcConnection = (
	listener: (snapshot: ConnectionSnapshot) => void,
	environmentId = activeEnvironmentId,
): (() => void) => getRendererEntry(environmentId).subscribe(listener);

export const retryRendererRpcConnection = (environmentId?: unknown): void =>
	getRendererEntry(
		typeof environmentId === "string" ? environmentId : activeEnvironmentId,
	).retryNow();

export const dispatchRetryableRpcCommand = <A>(
	commandId: string,
	operation: () => Promise<A>,
	environmentId = activeEnvironmentId,
): Promise<A> =>
	getRendererEntry(environmentId).dispatchCommand(commandId, () => operation());

export const disposeRpcClient = async (): Promise<void> => {
	rendererEntries.clear();
	environmentConnections.clear();
	cloudWorkspaceRegistrations.clear();
	cloudWorkspaceRuntimeRecoveryCommands.clear();
	cloudWorkspaceAbnormalCloseCounts.clear();
	cloudWorkspaceHealthyConnections.clear();
	localEnvironmentId = LOCAL_ENVIRONMENT_KEY;
	setActiveEnvironmentStorageScope(LOCAL_RENDERER_STORAGE_SCOPE);
	await supervisor.dispose();
};

if (typeof window !== "undefined") {
	window.addEventListener("online", () => {
		online = true;
		supervisor.setOnline(true);
	});
	window.addEventListener("offline", () => {
		online = false;
		supervisor.setOnline(false);
	});
	window.addEventListener("pagehide", () => {
		void disposeRpcClient();
	});
}
