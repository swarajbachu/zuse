import {
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import { choosePreferredEndpoint } from "@zuse/client-runtime/endpoint-selection";
import { parseEnvironmentRoute } from "@zuse/client-runtime/environment-scope";
import {
	type ConnectionSnapshot,
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import {
	type EnvironmentEndpoint,
	MemoizeRpcs,
	type RelayConnectGrant,
	WIRE_PROTOCOL_VERSION,
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
import { electronClientProtocolLayer } from "./electron-client-protocol.ts";
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
			readonly kind: "browser";
	  }
	| {
			readonly key: `environment:${string}`;
			readonly kind: "remote";
			readonly environmentId: string;
			readonly wsUrl?: string;
			readonly token?: string;
	  };

const ACTIVE_ENVIRONMENT_KEY = "zuse.active-environment-id";

const browserConnectionKey = (): string => {
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

const controlPlaneOptions = (): RendererConnectionOptions => {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return bridge
		? { key: "control-plane", kind: "electron", bridge: bridge.rpc }
		: { key: browserConnectionKey(), kind: "browser" };
};

let online = globalThis.navigator?.onLine ?? true;

export const webSocketConnectionOwnerForTest = (
	kind: "browser" | "remote",
): "control-plane" | "environment" =>
	kind === "browser" ? "control-plane" : "environment";

const reportWebSocketClose = (
	kind: "browser" | "remote",
	event: { readonly code: number },
): void => {
	const entry =
		webSocketConnectionOwnerForTest(kind) === "control-plane"
			? controlPlaneEntry
			: rendererEntry;
	entry?.reportFailure(new Error(`WebSocket closed (${event.code}).`));
};

const createClient = async (options: RendererConnectionOptions) => {
	const protocolLayer =
		options.kind === "electron"
			? electronClientProtocolLayer(options.bridge).pipe(
					Layer.provide(RpcSerialization.layerJson),
				)
			: options.kind === "browser"
				? wsClientProtocolLayer(
						withWireProtocolVersion(
							await requestBrowserWebSocketUrl(),
							WIRE_PROTOCOL_VERSION,
						),
						{
							onClose: (event) => reportWebSocketClose("browser", event),
						},
					)
				: wsClientProtocolLayer(
						remoteWebSocketUrl(options.wsUrl, options.token),
						{
							onClose: (event) => reportWebSocketClose("remote", event),
						},
					);
	return instrumentRendererRpcClient(
		await makeRpcClientSession(protocolLayer, MemoizeRpcs, {
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		}),
	);
};

const controlSupervisor = createConnectionSupervisor<
	RendererConnectionOptions,
	MemoizeClient
>({
	keyOf: (options) => options.key,
	isOnline: () => online,
	schedule: (delayMs, reconnect) => {
		const timer = setTimeout(reconnect, delayMs);
		return () => clearTimeout(timer);
	},
	createClient,
	isRetryableCommandError: isRpcClientError,
});

const environmentSupervisor = createConnectionSupervisor<
	RendererConnectionOptions,
	MemoizeClient
>({
	keyOf: (options) => options.key,
	isOnline: () => online,
	schedule: (delayMs, reconnect) => {
		const timer = setTimeout(reconnect, delayMs);
		return () => clearTimeout(timer);
	},
	prepareOptions: async (
		options: RendererConnectionOptions,
	): Promise<RendererConnectionOptions> => {
		if (options.kind !== "remote") return options;
		const control: MemoizeClient = await Effect.runPromise(
			getControlPlaneEntry().getClient(),
		);
		const grant = await Effect.runPromise(
			control["environments.connect"]({
				environmentId: options.environmentId as never,
			}),
		);
		const endpoint = await chooseGrantEndpoint(grant);
		return {
			...options,
			wsUrl: endpoint.wsBaseUrl,
			token: grant.connectToken,
		};
	},
	createClient,
	isRetryableCommandError: isRpcClientError,
});

let rendererEntry: ConnectionSupervisorEntry<MemoizeClient> | null = null;
let controlPlaneEntry: ConnectionSupervisorEntry<MemoizeClient> | null = null;

const remoteWebSocketUrl = (
	wsUrl: string | undefined,
	token: string | undefined,
): string => {
	if (wsUrl === undefined || token === undefined) {
		throw new Error("Remote environment connect grant is incomplete");
	}
	const url = new URL(wsUrl);
	url.searchParams.set("token", token);
	url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
	return url.toString();
};

const probeWebSocket = (
	endpoint: EnvironmentEndpoint,
	token: string,
): Promise<boolean> =>
	new Promise((resolve) => {
		let settled = false;
		const socket = new WebSocket(remoteWebSocketUrl(endpoint.wsBaseUrl, token));
		const finish = (reachable: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.close();
			resolve(reachable);
		};
		const timer = window.setTimeout(() => finish(false), 1_200);
		socket.addEventListener("open", () => finish(true), { once: true });
		socket.addEventListener("error", () => finish(false), { once: true });
	});

export const chooseGrantEndpoint = async (
	grant: RelayConnectGrant,
): Promise<EnvironmentEndpoint> =>
	choosePreferredEndpoint(grant, probeWebSocket);

const getControlPlaneEntry = (): ConnectionSupervisorEntry<MemoizeClient> => {
	if (controlPlaneEntry === null) {
		controlPlaneEntry = controlSupervisor.get(controlPlaneOptions());
	}
	return controlPlaneEntry;
};

const getRendererEntry = (): ConnectionSupervisorEntry<MemoizeClient> => {
	const environmentId = getActiveEnvironmentId();
	if (environmentId === null) return getControlPlaneEntry();
	const options: RendererConnectionOptions = {
		key: `environment:${environmentId}` as `environment:${string}`,
		kind: "remote",
		environmentId,
	};
	const entry = environmentSupervisor.get(options);
	if (rendererEntry === null) {
		rendererEntry = entry;
	}
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

export const getRpcClient = (): Promise<MemoizeClient> =>
	Effect.runPromise(getRendererEntry().getClient());

export const getControlPlaneRpcClient = (): Promise<MemoizeClient> =>
	Effect.runPromise(getControlPlaneEntry().getClient());

export const getActiveEnvironmentId = (): string | null => {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	if (bridge === undefined) return null;
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(ACTIVE_ENVIRONMENT_KEY);
};

export const selectEnvironment = async (
	environmentId: string | null,
): Promise<void> => {
	if (environmentId === null) {
		localStorage.removeItem(ACTIVE_ENVIRONMENT_KEY);
	} else {
		localStorage.setItem(ACTIVE_ENVIRONMENT_KEY, environmentId);
	}
	await disposeRpcClient();
	location.reload();
};

export const reportRendererRpcFailure = (cause: unknown): void => {
	getRendererEntry().reportFailure(cause);
};

/** Report a long-lived stream failure once for the connection that owned it. */
export const reportRendererRpcStreamFailure = (
	generation: number,
	cause: unknown,
): boolean => getRendererEntry().reportFailure(cause, generation);

/**
 * Observe the shared renderer connection lifecycle. Long-lived RPC streams use
 * the generation edge to resubscribe without implementing their own retry loop
 * or bypassing the supervisor's bounded exponential backoff.
 */
export const subscribeRendererRpcConnection = (
	listener: (snapshot: ConnectionSnapshot) => void,
): (() => void) => getRendererEntry().subscribe(listener);

export const retryRendererRpcConnection = (): void =>
	getRendererEntry().retryNow();

export const dispatchRetryableRpcCommand = <A>(
	commandId: string,
	operation: () => Promise<A>,
): Promise<A> =>
	getRendererEntry().dispatchCommand(commandId, () => operation());

export const disposeRpcClient = async (): Promise<void> => {
	rendererEntry = null;
	controlPlaneEntry = null;
	await Promise.all([
		controlSupervisor.dispose(),
		environmentSupervisor.dispose(),
	]);
};

if (typeof window !== "undefined") {
	window.addEventListener("online", () => {
		online = true;
		controlSupervisor.setOnline(true);
		environmentSupervisor.setOnline(true);
	});
	window.addEventListener("offline", () => {
		online = false;
		controlSupervisor.setOnline(false);
		environmentSupervisor.setOnline(false);
	});
	window.addEventListener("pagehide", () => {
		void disposeRpcClient();
	});
}
