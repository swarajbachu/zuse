import {
	isRpcCredentialExpired,
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
	type WorkspaceScope,
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
import { cloudFailurePresentation } from "./cloud-failure-presentation.ts";
import { cloudSummaryForEnvironment } from "./cloud-workspace-catalog.ts";
import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";
import { electronClientProtocolLayer } from "./electron-client-protocol.ts";
import { isPlatformOnline, subscribePlatformOnline } from "./network-status.ts";
import { isHostedProduct } from "./platform-capabilities.ts";
import {
	assertRendererAccountCurrent,
	type RendererAccountSnapshot,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	LOCAL_RENDERER_STORAGE_SCOPE,
	setActiveEnvironmentStorageScope,
} from "./renderer-environment-scope.ts";
import {
	rendererWorkspaceSnapshot,
	workspaceScopeKey,
} from "./renderer-workspace.ts";
import { instrumentRendererRpcClient } from "./rpc-stall-instrumentation.ts";
import { withWorkspaceScope } from "./workspace-rpc-client.ts";
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
			readonly account?: RendererAccountSnapshot;
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

/** Only WebSocket transports cross the network; the Electron bridge is in-process. */
export const connectionRequiresNetwork = (
	options: Pick<RendererConnectionOptions, "kind">,
): boolean => options.kind === "websocket";

const environmentConnections = new Map<string, RendererConnectionOptions>();
type CloudWorkspaceRegistration = {
	readonly workspaceScope: WorkspaceScope;
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
	const result = cloudGatewayCloseRecovery(
		close.code,
		cloudWorkspaceHealthyConnections.has(workspaceId),
		cloudWorkspaceAbnormalCloseCounts.get(workspaceId) ?? 0,
	);
	if (result.abnormalCloses === 0)
		cloudWorkspaceAbnormalCloseCounts.delete(workspaceId);
	else
		cloudWorkspaceAbnormalCloseCounts.set(workspaceId, result.abnormalCloses);
	if (result.recover) requestCloudWorkspaceRuntimeRecovery(workspaceId);
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
 * healthy-looking but detached api record cannot cause a reconnect loop. */
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
				...(isHostedProduct() ? { account: rendererAccountSnapshot() } : {}),
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

/**
 * Whether reaching this environment depends on the network. Unknown ids are
 * treated as network-backed: cloud workspaces register their transport inside
 * the resolver's prepare step, after the platform offline check runs.
 */
export const environmentRequiresNetwork = (environmentId: string): boolean => {
	const options =
		environmentConnections.get(environmentId) ??
		(environmentId === LOCAL_ENVIRONMENT_KEY ? connectionOptions() : undefined);
	return options === undefined || connectionRequiresNetwork(options);
};

const prepareRendererConnectionOptions = async (
	options: RendererConnectionOptions,
): Promise<RendererConnectionOptions> => {
	if (options.kind !== "websocket") return options;
	assertConnectionAccount(options);
	if (options.refreshConnection !== undefined) {
		const connection = await options.refreshConnection();
		assertConnectionAccount(options);
		return {
			...options,
			wsUrl: connection.wsUrl,
			protocols: [connection.protocol, connection.credential],
		};
	}
	const prepared =
		options.refreshWsUrl === undefined
			? options
			: { ...options, wsUrl: await options.refreshWsUrl() };
	assertConnectionAccount(options);
	return prepared;
};

const assertConnectionAccount = (options: RendererConnectionOptions): void => {
	if (options.kind === "websocket" && options.account !== undefined)
		assertRendererAccountCurrent(options.account);
};

export const RENDERER_WEBSOCKET_OPEN_TIMEOUT = "3 seconds" as const;
export const CLOUD_WEBSOCKET_OPEN_TIMEOUT = "15 seconds" as const;

// Cloud gateway opening includes the remote TLS/upgrade round trip. Keep
// local failures fast without rejecting healthy, slower cloud connections.
export const rendererWebSocketOpenTimeout = (key: string) =>
	key.startsWith("workspace:")
		? CLOUD_WEBSOCKET_OPEN_TIMEOUT
		: RENDERER_WEBSOCKET_OPEN_TIMEOUT;

const CLOUD_WORKSPACE_MAX_AUTOMATIC_ATTEMPTS = 6;

// Retrying a cloud workspace can wake a billable machine, so its background
// retries stop after a short ladder. A self-hosted computer that sleeps or
// drops off the network must reconnect on its own when it comes back.
export const rendererMaxAutomaticAttempts = (
	options: Pick<RendererConnectionOptions, "key">,
): number =>
	options.key.startsWith("workspace:")
		? CLOUD_WORKSPACE_MAX_AUTOMATIC_ATTEMPTS
		: Number.POSITIVE_INFINITY;

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
	const category =
		typeof coded.code === "string"
			? coded.code
			: typeof coded.reason === "string"
				? coded.reason
				: undefined;
	return cloudFailurePresentation({ category })?.kind === "sign-in-required";
};

const makeRendererRpcSession = async (
	options: RendererConnectionOptions,
	onClose: (event: WebSocketCloseInfo) => void,
): Promise<RendererRpcSession> => {
	assertConnectionAccount(options);
	let closed = false;
	const notifyClose = (event: WebSocketCloseInfo): void => {
		if (closed) return;
		closed = true;
		onClose(event);
	};
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
						openTimeout: rendererWebSocketOpenTimeout(options.key),
						makeWebSocket:
							options.protocols === undefined
								? undefined
								: (url) =>
										new globalThis.WebSocket(url, [
											...(options.protocols ?? []),
										]),
						onClose: notifyClose,
					},
				);
	assertConnectionAccount(options);
	const session = instrumentRendererRpcClient(
		await makeRpcClientSession(protocolLayer, MemoizeRpcs, {
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		}),
	);
	try {
		assertConnectionAccount(options);
	} catch (cause) {
		await session.dispose();
		throw cause;
	}
	if (options.kind !== "websocket" || options.account === undefined)
		return session;
	let disposal: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		unsubscribe();
		disposal ??= session.dispose();
		return disposal;
	};
	const unsubscribe = subscribeRendererAccount(() => {
		if (options.account === rendererAccountSnapshot()) return;
		void dispose().catch(() => undefined);
		notifyClose({
			code: 1000,
			reason: "Connection account changed",
			wasClean: true,
		});
	});
	return { client: session.client, dispose };
};

const supervisor = createConnectionSupervisor<
	RendererConnectionOptions,
	MemoizeClient
>({
	keyOf: (options) => options.key,
	prepareOptions: prepareRendererConnectionOptions,
	isOnline: isPlatformOnline,
	requiresNetwork: connectionRequiresNetwork,
	isIgnorableFailure: isIgnorableRendererFailure,
	maxAutomaticAttempts: rendererMaxAutomaticAttempts,
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
		previous.account !== next.account ||
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
	if (isRpcCredentialExpired(cause)) return true;
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
 * Account operations use hosted HTTP on web and the owning desktop elsewhere,
 * independently of the runtime selected for a chat.
 */
export const getControlPlaneRpcClient = async (
	scope: WorkspaceScope = rendererWorkspaceSnapshot().scope,
): Promise<MemoizeClient> => {
	const account = rendererAccountSnapshot();
	const client = await getRpcClient(localEnvironmentId);
	if (scope.kind === "organization") {
		const welcome = await Effect.runPromise(
			client["connect.handshake"]({ protocolVersion: WIRE_PROTOCOL_VERSION }),
		);
		if (welcome.workspaceScopeProtocol !== 1)
			throw new Error(
				"Update Zuse on this computer before using organization workspaces.",
			);
	}
	assertRendererAccountCurrent(account);
	return withWorkspaceScope(client, scope);
};

/** Background command recovery follows the runtime owner, never the selected UI. */
export const getCloudWorkspaceScope = (
	workspaceId: string,
): WorkspaceScope | undefined =>
	cloudWorkspaceRegistrations.get(workspaceId)?.workspaceScope ??
	cloudSummaryForEnvironment(workspaceId)?.workspaceScope;

/**
 * This desktop's own server. It serves every workspace: each of its projects
 * records an owning workspace, and `scopeEnvironmentShell` shows only the
 * projects of the selected one.
 */
export const isDesktopLocalEnvironment = (environmentId: string): boolean =>
	!isHostedProduct() &&
	(environmentId === LOCAL_ENVIRONMENT_KEY ||
		environmentId === localEnvironmentId);

/** Remote device connections (SSH, tailnet, paired) remain Personal. */
export const environmentBelongsToWorkspace = (
	environmentId: string,
	scope: WorkspaceScope = rendererWorkspaceSnapshot().scope,
): boolean =>
	environmentId === LOCAL_ENVIRONMENT_KEY ||
	isDesktopLocalEnvironment(environmentId) ||
	workspaceScopeKey(
		getCloudWorkspaceScope(environmentId) ?? { kind: "personal" },
	) === workspaceScopeKey(scope);

const assertCloudConnectionOwner = (
	workspaceId: string,
	scope: WorkspaceScope,
	connection: CloudWorkspaceConnection,
): void => {
	if (
		connection.workspaceId !== workspaceId ||
		workspaceScopeKey(connection.workspaceScope ?? { kind: "personal" }) !==
			workspaceScopeKey(scope)
	)
		throw new Error("Cloud workspace connection ownership changed.");
};

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

export const registerApiEnvironment = (
	environmentId: string,
	initialWsUrl: string,
	refreshWsUrl: () => Promise<string>,
	account: RendererAccountSnapshot,
): void => {
	assertRendererAccountCurrent(account);
	let initial: string | null = initialWsUrl;
	environmentConnections.set(environmentId, {
		key: `environment:${environmentId}`,
		kind: "websocket",
		wsUrl: initialWsUrl,
		account,
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
	account: RendererAccountSnapshot,
): void => {
	assertRendererAccountCurrent(account);
	const existingEntry = rendererEntries.get(workspaceId);
	let registration = cloudWorkspaceRegistrations.get(workspaceId);
	const scope = registration?.workspaceScope ??
		initial.workspaceScope ?? {
			kind: "personal",
		};
	assertCloudConnectionOwner(workspaceId, scope, initial);
	if (registration === undefined) {
		const created: CloudWorkspaceRegistration = {
			workspaceScope: scope,
			connection: initial,
			refresh: refreshConnection,
			refreshStable: async () => {
				const current = cloudWorkspaceRegistrations.get(workspaceId);
				if (current === undefined)
					throw new Error("Cloud workspace connection was removed.");
				if (canReuseCloudWorkspaceTicket(current.connection))
					return current.connection;
				const refreshed = await current.refresh();
				assertCloudConnectionOwner(
					workspaceId,
					current.workspaceScope,
					refreshed,
				);
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
			account,
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

/** Device profiles retain independent authority; unknown routes are not trusted. */
export const rendererEnvironmentCommandAuthority = (
	environmentId: string,
): "device" | RendererAccountSnapshot | undefined => {
	const options = environmentConnections.get(environmentId);
	if (options !== undefined)
		return options.kind === "websocket" && options.account !== undefined
			? options.account
			: "device";
	return environmentId === LOCAL_ENVIRONMENT_KEY
		? isHostedProduct()
			? rendererAccountSnapshot()
			: "device"
		: undefined;
};

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

const unsubscribeConnectionAccount = subscribeRendererAccount(() => {
	for (const [environmentId, options] of environmentConnections) {
		if (options.kind !== "websocket" || options.account === undefined) continue;
		if (options.account === rendererAccountSnapshot()) continue;
		void removeRendererEnvironment(environmentId).catch(() => undefined);
	}
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeConnectionAccount);

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

/**
 * Restart interrupted self-hosted connections after this device resumes or
 * regains focus. Cloud workspaces keep their bounded ladder so a wake never
 * starts billable compute without user intent.
 */
export const retryInterruptedRendererRpcConnections = (): void => {
	for (const entry of rendererEntries.values()) {
		const { key, status } = entry.snapshot();
		if (key.startsWith("workspace:")) continue;
		if (status === "reconnecting" || status === "error") entry.retryNow();
	}
};

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

subscribePlatformOnline(() => supervisor.setOnline(isPlatformOnline()));

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => {
		void disposeRpcClient();
	});
}

import { cloudGatewayCloseRecovery } from "@zuse/client-runtime/cloud-gateway-recovery";
