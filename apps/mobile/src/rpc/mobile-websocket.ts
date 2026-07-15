import {
	logConnectionDiagnostic,
	logConnectionProblem,
} from "./connection-diagnostics";

const OPEN_SLOW_MS = 12_000;

const endpointFields = (rawUrl: string): Record<string, unknown> => {
	try {
		const url = new URL(rawUrl);
		return {
			origin: url.origin,
			path: url.pathname,
			hasToken: url.searchParams.has("token"),
			wireVersion: url.searchParams.get("wireVersion"),
		};
	} catch {
		return { endpoint: "invalid" };
	}
};

/**
 * React Native's WebSocket errors contain little useful detail. Record the
 * lifecycle around the native socket without ever logging its bearer token.
 */
export const makeMobileWebSocket = (
	url: string,
	protocols?: string | string[],
): globalThis.WebSocket => {
	const startedAt = Date.now();
	const fields = endpointFields(url);
	const socket = new globalThis.WebSocket(url, protocols);
	let opened = false;
	const slowTimer = setTimeout(() => {
		if (opened) return;
		logConnectionProblem("socket.open.slow", {
			...fields,
			elapsedMs: Date.now() - startedAt,
			readyState: socket.readyState,
		});
	}, OPEN_SLOW_MS);

	logConnectionDiagnostic("socket.create", fields);
	socket.addEventListener("open", () => {
		opened = true;
		clearTimeout(slowTimer);
		logConnectionDiagnostic("socket.open", {
			...fields,
			elapsedMs: Date.now() - startedAt,
		});
	});
	socket.addEventListener("error", (event) => {
		clearTimeout(slowTimer);
		logConnectionProblem("socket.error", {
			...fields,
			elapsedMs: Date.now() - startedAt,
			readyState: socket.readyState,
			eventType: event.type,
		});
	});
	socket.addEventListener("close", (event) => {
		clearTimeout(slowTimer);
		logConnectionProblem("socket.close", {
			...fields,
			elapsedMs: Date.now() - startedAt,
			opened,
			code: event.code,
			clean: event.wasClean,
			reason: event.reason || null,
		});
	});
	return socket;
};
