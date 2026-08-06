import {
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import { parseEnvironmentRoute } from "@zuse/client-runtime/environment-scope";
import {
	type ConnectionSnapshot,
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	type RpcClient,
	type RpcGroup,
	RpcSerialization,
} from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { RpcBridge } from "./bridge.ts";
import { requestBrowserWebSocketUrl } from "./browser-session.ts";
import { electronClientProtocolLayer } from "./electron-client-protocol.ts";
import {
	LOCAL_RENDERER_STORAGE_SCOPE,
	setActiveEnvironmentStorageScope,
} from "./renderer-environment-scope.ts";
import { instrumentRendererRpcClient } from "./rpc-stall-instrumentation.ts";
import { wsClientProtocolLayer } from "./ws-client-protocol.ts";

type MemoizeClient = RpcClient.RpcClient<
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
			readonly refreshWsUrl?: () => Promise<string>;
	  };

export const LOCAL_ENVIRONMENT_KEY = "local";

const environmentConnections = new Map<string, RendererConnectionOptions>();
let activeEnvironmentId = LOCAL_ENVIRONMENT_KEY;

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

export function resolveRendererRpcTransportForTest(): {
	readonly kind: "electron" | "websocket";
	readonly wsUrl?: string;
} {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return bridge
		? { kind: "electron" }
		: { kind: "websocket", wsUrl: resolveWebSocketUrl() };
}

const connectionOptions = (): RendererConnectionOptions => {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return bridge
		? { key: rendererConnectionKey(), kind: "electron", bridge: bridge.rpc }
		: {
				key: rendererConnectionKey(),
				kind: "websocket",
				wsUrl: resolveWebSocketUrl(),
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

let online = globalThis.navigator?.onLine ?? true;

const supervisor = createConnectionSupervisor<
	RendererConnectionOptions,
	MemoizeClient
>({
	keyOf: (options) => options.key,
	prepareOptions: async (options) =>
		options.kind === "websocket" && options.refreshWsUrl !== undefined
			? { ...options, wsUrl: await options.refreshWsUrl() }
			: options,
	isOnline: () => online,
	schedule: (delayMs, reconnect) => {
		const timer = setTimeout(reconnect, delayMs);
		return () => clearTimeout(timer);
	},
	createClient: async (options) => {
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
							onClose: (event) => {
								reportRendererEntryFailure(
									options.key,
									new Error(`WebSocket closed (${event.code}).`),
								);
							},
						},
					);
		return instrumentRendererRpcClient(
			await makeRpcClientSession(protocolLayer, MemoizeRpcs, {
				protocolVersion: WIRE_PROTOCOL_VERSION,
				perform: (client, hello) => client["connect.handshake"](hello),
			}),
		);
	},
	isRetryableCommandError: isRpcClientError,
	shouldReconnectOnOptionsChange: (previous, next) =>
		previous.kind !== next.kind ||
		(previous.kind === "websocket" &&
			next.kind === "websocket" &&
			previous.wsUrl !== next.wsUrl),
});

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

function isRpcClientError(cause: unknown): boolean {
	return (
		typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		cause._tag === "RpcClientError"
	);
}

export const getRpcClient = (environmentId?: unknown): Promise<MemoizeClient> =>
	Effect.runPromise(
		getRendererEntry(
			typeof environmentId === "string" ? environmentId : activeEnvironmentId,
		).getClient(),
	);

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

export const registerLocalEnvironment = (environmentId: string): void => {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	if (bridge === undefined) return;
	environmentConnections.set(environmentId, {
		key: `environment:${environmentId}`,
		kind: "electron",
		bridge: bridge.rpc,
	});
};

export const setActiveEnvironment = (environmentId: string): void => {
	const options = optionsForEnvironment(environmentId);
	activeEnvironmentId = environmentId;
	setActiveEnvironmentStorageScope(
		options.kind === "electron" ? LOCAL_RENDERER_STORAGE_SCOPE : environmentId,
	);
};

export const getActiveEnvironment = (): string => activeEnvironmentId;

export const removeRendererEnvironment = async (
	environmentId: string,
): Promise<void> => {
	environmentConnections.delete(environmentId);
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
