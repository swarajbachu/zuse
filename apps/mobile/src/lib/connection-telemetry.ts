import type { WsProtocolOptions } from "@zuse/client-runtime/ws-protocol";

/** Which path a connection takes; bounded values for analytics. */
export const connectionKind = (options: WsProtocolOptions): string => {
	if (options.cloudWorkspaceId !== undefined) return "cloud";
	if (options.host === "127.0.0.1" && options.serverKeyPin !== undefined)
		return "local_proxy";
	if (options.refreshAccountGrant === true) return "account";
	if (options.serverKeyPin !== undefined) return "lan_direct";
	return "manual";
};

/** Coarse, stable reason codes; raw messages never leave the device. */
export const connectionLossCode = (reason: string | undefined): string => {
	const text = (reason ?? "").toLowerCase();
	if (text.includes("ping timeout")) return "ping_timeout";
	if (text.includes("credential-expired")) return "credential_expired";
	if (text.includes("decod")) return "decode_error";
	if (text.includes("health check timed out")) return "probe_timeout";
	if (text.includes("timed out") || text.includes("timeout")) return "timeout";
	if (text.includes("close")) return "socket_closed";
	if (text.includes("open")) return "socket_open_failed";
	return "other";
};

type Tracked = { connectedAt: number | null; lostAt: number | null };

export type ConnectionTelemetryEvent =
	| {
			readonly name: "connection lost";
			readonly properties: {
				readonly connection_kind: string;
				readonly duration_ms: number;
				readonly error_code: string;
			};
	  }
	| {
			readonly name: "connection restored";
			readonly properties: {
				readonly connection_kind: string;
				readonly duration_ms: number;
			};
	  };

/** Supervisor diagnostics that end a live session, with their reason code. */
const LOSS_EVENTS: Readonly<Record<string, string | null>> = {
	"supervisor.failure.replace": null,
	"supervisor.health.failed": null,
	"supervisor.session.replace": "resume_replace",
	"supervisor.options.updated": "route_changed",
};

/**
 * Turns supervisor diagnostics into "connection lost" (with how long the
 * session lived) and "connection restored" (with how long it was down).
 */
export const createConnectionTelemetry = (now: () => number = Date.now) => {
	const tracked = new Map<string, Tracked>();
	return (
		event: string,
		key: string,
		details: Readonly<Record<string, unknown>> | undefined,
		options: WsProtocolOptions | undefined,
	): ConnectionTelemetryEvent | null => {
		const state = tracked.get(key) ?? { connectedAt: null, lostAt: null };
		tracked.set(key, state);
		const kind = options === undefined ? "unknown" : connectionKind(options);
		if (event === "supervisor.connection.ready") {
			const lostAt = state.lostAt;
			state.connectedAt = now();
			state.lostAt = null;
			return lostAt === null
				? null
				: {
						name: "connection restored",
						properties: {
							connection_kind: kind,
							duration_ms: state.connectedAt - lostAt,
						},
					};
		}
		if (!(event in LOSS_EVENTS) || state.connectedAt === null) return null;
		const reason =
			typeof details?.reason === "string" ? details.reason : undefined;
		const code = LOSS_EVENTS[event] ?? connectionLossCode(reason);
		const lifetime = now() - state.connectedAt;
		state.connectedAt = null;
		state.lostAt = now();
		return {
			name: "connection lost",
			properties: {
				connection_kind: kind,
				duration_ms: lifetime,
				error_code: code,
			},
		};
	};
};
