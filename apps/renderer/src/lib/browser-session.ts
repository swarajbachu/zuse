export type BrowserSessionStatus = {
	readonly authenticated: boolean;
	readonly authRequired: boolean;
};

export class BrowserSessionError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string,
	) {
		super(reason);
		this.name = "BrowserSessionError";
	}
}

const jsonRequest = async <A>(path: string, init?: RequestInit): Promise<A> => {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: {
			...(init?.body === undefined
				? {}
				: { "content-type": "application/json" }),
			...init?.headers,
		},
	});
	const body = (await response.json().catch(() => ({}))) as {
		readonly error?: string;
	};
	if (!response.ok) {
		throw new BrowserSessionError(
			response.status,
			body.error ?? `request_${response.status}`,
		);
	}
	return body as A;
};

export const readAndClearPairingFragment = (
	location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
	history: Pick<History, "replaceState"> = window.history,
): string | null => {
	const fragment = new URLSearchParams(location.hash.replace(/^#/u, ""));
	const credential = fragment.get("pair");
	if (credential !== null) {
		history.replaceState(null, "", `${location.pathname}${location.search}`);
	}
	return credential;
};

export const getBrowserSession = (): Promise<BrowserSessionStatus> =>
	jsonRequest<BrowserSessionStatus>("/auth/session");

export const exchangeBrowserPairing = (
	credential: string,
): Promise<BrowserSessionStatus> =>
	jsonRequest<BrowserSessionStatus>("/auth/browser-session", {
		method: "POST",
		body: JSON.stringify({ credential }),
	});

type BrowserSessionConnectionDependencies = {
	readonly readPairing: () => string | null;
	readonly getSession: () => Promise<BrowserSessionStatus>;
	readonly exchangePairing: (
		credential: string,
	) => Promise<BrowserSessionStatus>;
};

/**
 * Coordinates browser authentication across concurrent React callers.
 * Development Strict Mode intentionally runs effects twice, while pairing
 * credentials are intentionally single-use. Keeping the exchange single-flight
 * prevents a second effect from consuming the same credential and overwriting
 * a successful connection with an invalid-code response.
 */
export const createBrowserSessionConnection = (
	dependencies: BrowserSessionConnectionDependencies = {
		readPairing: readAndClearPairingFragment,
		getSession: getBrowserSession,
		exchangePairing: exchangeBrowserPairing,
	},
): { readonly connect: () => Promise<BrowserSessionStatus> } => {
	let pairingRead = false;
	let pairing: string | null = null;
	let inFlight: Promise<BrowserSessionStatus> | null = null;

	const connect = (): Promise<BrowserSessionStatus> => {
		if (inFlight !== null) return inFlight;
		if (!pairingRead) {
			pairing = dependencies.readPairing();
			pairingRead = true;
		}

		const attempt =
			pairing === null
				? dependencies.getSession()
				: dependencies.exchangePairing(pairing);
		inFlight = attempt;
		const clearAttempt = () => {
			if (inFlight === attempt) inFlight = null;
		};
		void attempt.then((session) => {
			if (session.authenticated) pairing = null;
			clearAttempt();
		}, clearAttempt);
		return attempt;
	};

	return { connect };
};

export const logoutBrowserSession = (): Promise<BrowserSessionStatus> =>
	jsonRequest<BrowserSessionStatus>("/auth/logout", { method: "POST" });

export const requestBrowserWebSocketUrl = async (): Promise<string> => {
	const result = await jsonRequest<{
		readonly ticket: string;
	}>("/auth/websocket-ticket", { method: "POST" });
	const configured = (
		import.meta as { readonly env?: Record<string, string | undefined> }
	).env?.VITE_ZUSE_WS_URL?.trim();
	const url = new URL(
		configured || "/rpc",
		configured
			? window.location.href
			: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`,
	);
	url.searchParams.set("ticket", result.ticket);
	return url.toString();
};
