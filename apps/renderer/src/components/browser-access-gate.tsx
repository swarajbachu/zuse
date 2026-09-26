import "@zuse/i18n/english/shell";
import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import {
	BrowserSessionError,
	createBrowserSessionConnection,
	exchangeBrowserPairing,
} from "../lib/browser-session.ts";
import {
	beginHostedSignIn,
	completeHostedSignIn,
	hostedSignedIn,
	isHostedProduct,
} from "../lib/hosted-connect.ts";
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
			readonly retryable: boolean;
			readonly pairingAllowed: boolean;
	  };

type HostedAccessState =
	| { readonly status: "loading" }
	| { readonly status: "signedOut" }
	| { readonly status: "ready" }
	| { readonly status: "error"; readonly description: string };

const errorCopy = (
	cause: unknown,
): Omit<Extract<AccessState, { status: "error" }>, "status"> => {
	if (cause instanceof BrowserSessionError) {
		if (cause.status === 410) {
			return {
				title: uiMessage("shell:browser_access_gate_this_pairing_link_expired"),
				description: uiMessage(
					"shell:browser_access_gate_create_a_fresh_pairing_code_on_the_other_computer_then_enter_it_b",
				),
				retryable: false,
				pairingAllowed: true,
			};
		}
		if (cause.status === 401) {
			return {
				title: uiMessage("shell:browser_access_gate_pair_this_browser"),
				description: uiMessage(
					"shell:browser_access_gate_use_a_pairing_code_once_then_this_address_will_keep_working_in_th",
				),
				retryable: false,
				pairingAllowed: true,
			};
		}
		if (cause.status === 426) {
			return {
				title: uiMessage(
					"shell:browser_access_gate_zuse_versions_do_not_match",
				),
				description: uiMessage(
					"shell:browser_access_gate_update_the_server_and_reload_this_page_before_reconnecting",
				),
				retryable: false,
				pairingAllowed: false,
			};
		}
	}
	return {
		title: navigator.onLine ? "Could not reach Zuse Serve" : "You are offline",
		description: navigator.onLine
			? "Check that the environment is running, then try again."
			: "Reconnect to the network and retry when you are ready.",
		retryable: true,
		pairingAllowed: false,
	};
};

function AccessCard({
	state,
	retry,
	pair,
}: {
	readonly state: Exclude<AccessState, { readonly status: "ready" }>;
	readonly retry: () => void;
	readonly pair: (code: string) => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "shell"]);

	const headingRef = useRef<HTMLHeadingElement>(null);
	const [code, setCode] = useState("");
	const [pairing, setPairing] = useState(false);
	const [pairingError, setPairingError] = useState<string | null>(null);
	useEffect(() => {
		if (state.status === "error") headingRef.current?.focus();
	}, [state.status]);
	const loading = state.status === "loading";
	const submitPairing = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pairing || code.trim().length === 0) return;
		setPairing(true);
		setPairingError(null);
		try {
			await pair(code.trim());
		} catch (cause) {
			if (cause instanceof BrowserSessionError) {
				setPairingError(
					cause.status === 429
						? "Too many attempts. Wait a moment and try again."
						: cause.status === 410
							? "That code expired. Create a new code and try again."
							: "That code is invalid or has already been used.",
				);
			} else {
				setPairingError("Could not pair this browser. Try again.");
			}
		} finally {
			setPairing(false);
		}
	};
	return (
		<div className="flex h-dvh w-screen items-center justify-center bg-background px-6 text-foreground">
			<main
				aria-busy={loading}
				aria-live="polite"
				className="w-full max-w-md rounded-xl border border-border/70 bg-card p-4 shadow-overlay-sm"
			>
				<p className="text-xs font-medium text-muted-foreground">
					{uiMessage("shell:browser_access_gate_zuse_serve")}
				</p>
				<h1
					className="mt-1.5 font-heading text-lg font-semibold outline-none"
					ref={headingRef}
					tabIndex={-1}
				>
					{loading
						? uiMessage(
								"shell:browser_access_gate_connecting_to_your_environment",
							)
						: state.title}
				</h1>
				<p className="mt-1.5 text-xs leading-5 text-muted-foreground">
					{loading
						? uiMessage(
								"shell:browser_access_gate_authentication_and_connection_recovery_happen_automatically",
							)
						: state.description}
				</p>
				{!loading && state.pairingAllowed ? (
					<form className="mt-4 space-y-2" onSubmit={submitPairing}>
						<label className="block text-xs font-medium" htmlFor="pairing-code">
							{uiMessage("shell:browser_access_gate_pairing_code")}
						</label>
						<div className="flex gap-2">
							<input
								autoCapitalize="characters"
								autoComplete="one-time-code"
								className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
								disabled={pairing}
								id="pairing-code"
								maxLength={256}
								onChange={(event) => setCode(event.target.value)}
								placeholder={uiMessage("shell:browser_access_gate_abcd_efgh")}
								value={code}
							/>
							<button
								className="h-7 rounded-md bg-primary px-2.5 font-medium text-primary-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
								disabled={pairing || code.trim().length === 0}
								type="submit"
							>
								{pairing
									? uiMessage("shell:browser_access_gate_connecting")
									: uiMessage("common:connect")}
							</button>
						</div>
						<p className="text-[11px] leading-4 text-muted-foreground">
							{uiMessage(
								"shell:browser_access_gate_enter_the_code_shown_on_the_other_computer_in_its_serve_terminal_or_se",
							)}
						</p>
						{pairingError !== null ? (
							<p className="text-xs text-destructive" role="alert">
								{pairingError}
							</p>
						) : null}
					</form>
				) : null}
				{!loading && state.retryable && (
					<button
						className="mt-5 inline-flex h-7 items-center justify-center rounded-md bg-primary px-2.5 font-medium text-primary-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						onClick={retry}
						type="button"
					>
						{uiMessage("shell:browser_access_gate_try_again")}
					</button>
				)}
			</main>
		</div>
	);
}

function ConnectionBanner() {
	const { message: uiMessage } = useUiMessages(["common", "shell"]);

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
			className="fixed inset-x-0 top-0 z-[100] flex h-9 items-center justify-center gap-2 border-border border-b bg-card/95 px-4 text-xs backdrop-blur"
		>
			<span>{label}</span>
			{snapshot.status !== "connecting" && (
				<button
					className="h-7 rounded-md px-2.5 font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					onClick={retryRendererRpcConnection}
					type="button"
				>
					{uiMessage("common:retry")}
				</button>
			)}
		</div>
	);
}

function HostedAccessCard({
	state,
	retry,
}: {
	readonly state: Exclude<HostedAccessState, { readonly status: "ready" }>;
	readonly retry: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "shell"]);

	const title =
		state.status === "loading"
			? "Opening Zuse…"
			: state.status === "signedOut"
				? "Your cloud agents, anywhere"
				: "Could not open Zuse";
	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background px-4 py-8 text-foreground">
			<main
				aria-busy={state.status === "loading"}
				aria-live="polite"
				className="w-full max-w-md rounded-xl border border-border/70 bg-card p-4 shadow-overlay-sm"
			>
				<p className="text-sm font-medium text-muted-foreground">
					{uiMessage("shell:browser_access_gate_zuse")}
				</p>
				<h1 className="mt-1.5 font-heading text-lg font-semibold">{title}</h1>
				{state.status === "loading" ? (
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						Signing in to your cloud workspace…
					</p>
				) : null}
				{state.status === "signedOut" ? (
					<>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							Sign in to set up cloud agents, connect repositories, and start
							chatting.
						</p>
						<button
							className="mt-4 h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => void beginHostedSignIn()}
							type="button"
						>
							{uiMessage("common:signIn")}
						</button>
					</>
				) : null}
				{state.status === "error" ? (
					<>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							{state.description}
						</p>
						<button
							className="mt-4 h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
							onClick={retry}
							type="button"
						>
							{uiMessage("shell:browser_access_gate_try_again")}
						</button>
					</>
				) : null}
			</main>
		</div>
	);
}

function HostedAccessGate({ children }: { readonly children: ReactNode }) {
	const [state, setState] = useState<HostedAccessState>({
		status: "loading",
	});
	const connect = useCallback(async () => {
		setState({ status: "loading" });
		try {
			await completeHostedSignIn();
			if (!(await hostedSignedIn())) {
				setState({ status: "signedOut" });
				return;
			}

			setState({ status: "ready" });
		} catch {
			setState({
				status: "error",
				description: "Could not sign in. Check your connection and try again.",
			});
		}
	}, []);
	useEffect(() => {
		void connect();
	}, [connect]);
	if (state.status !== "ready") {
		return <HostedAccessCard retry={() => void connect()} state={state} />;
	}
	return <>{children}</>;
}

function DirectBrowserAccessGate({
	children,
}: {
	readonly children: ReactNode;
}) {
	const [state, setState] = useState<AccessState>(() =>
		rendererPlatformCapabilities().desktop
			? { status: "ready" }
			: { status: "loading" },
	);
	const connectionRef = useRef<ReturnType<
		typeof createBrowserSessionConnection
	> | null>(null);
	connectionRef.current ??= createBrowserSessionConnection();

	const connect = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const session = await connectionRef.current?.connect();
			if (session === undefined) throw new Error("browser_session_unavailable");
			if (!session.authenticated) {
				throw new BrowserSessionError(401, "unauthorized");
			}
			setState({ status: "ready" });
		} catch (cause) {
			setState({ status: "error", ...errorCopy(cause) });
		}
	}, []);
	const pair = useCallback(async (code: string) => {
		const session = await exchangeBrowserPairing(code);
		if (!session.authenticated) {
			throw new BrowserSessionError(401, "unauthorized");
		}
		setState({ status: "ready" });
	}, []);

	useEffect(() => {
		if (rendererPlatformCapabilities().desktop) {
			setState({ status: "ready" });
			return;
		}
		void connect();
	}, [connect]);

	if (state.status !== "ready")
		return (
			<AccessCard pair={pair} retry={() => void connect()} state={state} />
		);
	return (
		<>
			{children}
			{!rendererPlatformCapabilities().desktop && <ConnectionBanner />}
		</>
	);
}

export function BrowserAccessGate({
	children,
}: {
	readonly children: ReactNode;
}) {
	return isHostedProduct() ? (
		<HostedAccessGate>{children}</HostedAccessGate>
	) : (
		<DirectBrowserAccessGate>{children}</DirectBrowserAccessGate>
	);
}
