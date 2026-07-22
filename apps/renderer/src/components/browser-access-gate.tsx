import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import {
	BrowserSessionError,
	exchangeBrowserPairing,
	getBrowserSession,
	readAndClearPairingFragment,
} from "../lib/browser-session.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import {
	retryRendererRpcConnection,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";

type AccessState =
	| { readonly status: "loading" }
	| { readonly status: "ready" }
	| {
			readonly status: "error";
			readonly title: string;
			readonly description: string;
	  };

const errorCopy = (
	cause: unknown,
): Omit<Extract<AccessState, { status: "error" }>, "status"> => {
	if (cause instanceof BrowserSessionError) {
		if (cause.status === 410) {
			return {
				title: "This pairing link expired",
				description:
					"Create a fresh browser link from the Devices pane in the desktop app.",
			};
		}
		if (cause.status === 401) {
			return {
				title: "Pair this browser",
				description:
					"Open a new browser link from the Devices pane to authorize this browser.",
			};
		}
		if (cause.status === 426) {
			return {
				title: "Zuse versions do not match",
				description:
					"Update the server and reload this page before reconnecting.",
			};
		}
	}
	return {
		title: navigator.onLine ? "Could not reach Zuse Serve" : "You are offline",
		description: navigator.onLine
			? "Check that the environment is running, then try again."
			: "Reconnect to the network and retry when you are ready.",
	};
};

function AccessCard({
	state,
	retry,
}: {
	readonly state: Exclude<AccessState, { readonly status: "ready" }>;
	readonly retry: () => void;
}) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (state.status === "error") headingRef.current?.focus();
	}, [state.status]);
	const loading = state.status === "loading";
	return (
		<div className="flex h-dvh w-screen items-center justify-center bg-background px-6 text-foreground">
			<main
				aria-busy={loading}
				aria-live="polite"
				className="w-full max-w-md rounded-xl border border-border/70 bg-card p-6 shadow-sm"
			>
				<p className="font-medium text-muted-foreground text-sm">Zuse Serve</p>
				<h1
					className="mt-2 font-semibold text-xl outline-none"
					ref={headingRef}
					tabIndex={-1}
				>
					{loading ? "Connecting to your environment…" : state.title}
				</h1>
				<p className="mt-2 text-muted-foreground text-sm leading-6">
					{loading
						? "Authentication and connection recovery happen automatically."
						: state.description}
				</p>
				{!loading && (
					<button
						className="mt-5 inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						onClick={retry}
						type="button"
					>
						Try again
					</button>
				)}
			</main>
		</div>
	);
}

function ConnectionBanner() {
	const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
	useEffect(() => subscribeRendererRpcConnection(setSnapshot), []);
	if (snapshot === null || snapshot.status === "connected") return null;
	const label =
		snapshot.status === "offline"
			? "Offline"
			: snapshot.status === "blockedAuth"
				? "Browser authorization expired"
				: snapshot.status === "connecting"
					? "Connecting…"
					: "Reconnecting…";
	return (
		<div
			aria-live="polite"
			className="fixed inset-x-0 top-0 z-[100] flex min-h-11 items-center justify-center gap-3 border-border border-b bg-card/95 px-4 text-sm shadow-xs backdrop-blur"
		>
			<span>{label}</span>
			{snapshot.status !== "connecting" && (
				<button
					className="min-h-11 rounded-md px-3 font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					onClick={retryRendererRpcConnection}
					type="button"
				>
					Retry
				</button>
			)}
		</div>
	);
}

export function BrowserAccessGate({
	children,
}: {
	readonly children: ReactNode;
}) {
	const [state, setState] = useState<AccessState>(() =>
		rendererPlatformCapabilities().desktop
			? { status: "ready" }
			: { status: "loading" },
	);
	const pairingRef = useRef<string | null>(null);

	const connect = useCallback(async () => {
		setState({ status: "loading" });
		try {
			pairingRef.current ??= readAndClearPairingFragment();
			const session =
				pairingRef.current === null
					? await getBrowserSession()
					: await exchangeBrowserPairing(pairingRef.current);
			if (!session.authenticated) {
				throw new BrowserSessionError(401, "unauthorized");
			}
			pairingRef.current = null;
			setState({ status: "ready" });
		} catch (cause) {
			setState({ status: "error", ...errorCopy(cause) });
		}
	}, []);

	useEffect(() => {
		if (rendererPlatformCapabilities().desktop) {
			setState({ status: "ready" });
			return;
		}
		void connect();
	}, [connect]);

	if (state.status !== "ready")
		return <AccessCard retry={() => void connect()} state={state} />;
	return (
		<>
			{children}
			{!rendererPlatformCapabilities().desktop && <ConnectionBanner />}
		</>
	);
}
