import {
	environmentRoute,
	parseEnvironmentRoute,
} from "@zuse/client-runtime/environment-scope";
import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import {
	ENVIRONMENT_PRESENCE_STALE_MS,
	type RelayEnvironmentRecord,
} from "@zuse/contracts";
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
	connectHostedEnvironment,
	hostedSignedIn,
	isHostedProduct,
	listHostedEnvironments,
	registerHostedClient,
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
	| {
			readonly status: "select";
			readonly environments: ReadonlyArray<RelayEnvironmentRecord>;
	  }
	| { readonly status: "ready" }
	| { readonly status: "error"; readonly description: string };

const errorCopy = (
	cause: unknown,
): Omit<Extract<AccessState, { status: "error" }>, "status"> => {
	if (cause instanceof BrowserSessionError) {
		if (cause.status === 410) {
			return {
				title: "This pairing link expired",
				description:
					"Create a fresh pairing code on the other computer, then enter it below.",
				retryable: false,
				pairingAllowed: true,
			};
		}
		if (cause.status === 401) {
			return {
				title: "Pair this browser",
				description:
					"Use a pairing code once, then this address will keep working in this browser.",
				retryable: false,
				pairingAllowed: true,
			};
		}
		if (cause.status === 426) {
			return {
				title: "Zuse versions do not match",
				description:
					"Update the server and reload this page before reconnecting.",
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
				{!loading && state.pairingAllowed ? (
					<form className="mt-5 space-y-3" onSubmit={submitPairing}>
						<label className="block text-sm font-medium" htmlFor="pairing-code">
							Pairing code
						</label>
						<div className="flex gap-2">
							<input
								autoCapitalize="characters"
								autoComplete="one-time-code"
								className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-base uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
								disabled={pairing}
								id="pairing-code"
								maxLength={256}
								onChange={(event) => setCode(event.target.value)}
								placeholder="ABCD-EFGH"
								value={code}
							/>
							<button
								className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
								disabled={pairing || code.trim().length === 0}
								type="submit"
							>
								{pairing ? "Connecting…" : "Connect"}
							</button>
						</div>
						<p className="text-muted-foreground text-xs leading-5">
							Enter the code shown on the other computer in its serve terminal
							or Settings → Remote access.
						</p>
						{pairingError !== null ? (
							<p className="text-destructive text-sm" role="alert">
								{pairingError}
							</p>
						) : null}
					</form>
				) : null}
				{!loading && state.retryable && (
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

function HostedAccessCard({
	state,
	retry,
}: {
	readonly state: Exclude<HostedAccessState, { readonly status: "ready" }>;
	readonly retry: () => void;
}) {
	const title =
		state.status === "loading"
			? "Opening Zuse…"
			: state.status === "signedOut"
				? "Your computers, anywhere"
				: state.status === "select"
					? "Choose a computer"
					: "Could not open this computer";
	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background px-4 py-8 text-foreground">
			<main
				aria-busy={state.status === "loading"}
				aria-live="polite"
				className="w-full max-w-lg rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6"
			>
				<p className="text-sm font-medium text-muted-foreground">Zuse</p>
				<h1 className="mt-2 text-xl font-semibold">{title}</h1>
				{state.status === "loading" ? (
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						Signing in and finding your served computers.
					</p>
				) : null}
				{state.status === "signedOut" ? (
					<>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							Sign in to see and securely control the computers linked to your
							account.
						</p>
						<button
							className="mt-5 min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => void beginHostedSignIn()}
							type="button"
						>
							Sign in
						</button>
					</>
				) : null}
				{state.status === "select" ? (
					<div className="mt-4 flex flex-col gap-2">
						{state.environments.map((environment) => {
							const online =
								environment.lastHeartbeat !== undefined &&
								Date.now() - environment.lastHeartbeat <=
									ENVIRONMENT_PRESENCE_STALE_MS;
							return (
								<button
									className="flex min-h-11 items-center gap-3 rounded-xl border border-border/70 px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
									key={environment.environmentId}
									onClick={() =>
										window.location.assign(
											environmentRoute(environment.environmentId),
										)
									}
									type="button"
								>
									<span
										aria-hidden="true"
										className={`size-2.5 shrink-0 rounded-full ${
											online ? "bg-emerald-500" : "bg-muted-foreground/35"
										}`}
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium">
											{environment.label ?? "Unnamed computer"}
										</span>
										<span className="block truncate text-xs text-muted-foreground">
											{online ? "Online" : "Offline"}
											{environment.runtimeVersion
												? ` · v${environment.runtimeVersion}`
												: ""}
										</span>
									</span>
								</button>
							);
						})}
						{state.environments.length === 0 ? (
							<p className="rounded-xl bg-muted px-3 py-4 text-sm text-muted-foreground">
								No computers are served yet. Run <code>npx @zusehq/serve</code>{" "}
								on a computer first.
							</p>
						) : null}
					</div>
				) : null}
				{state.status === "error" ? (
					<>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							{state.description}
						</p>
						<button
							className="mt-5 min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={retry}
							type="button"
						>
							Try again
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
			const catalog = await listHostedEnvironments();
			const route = parseEnvironmentRoute(window.location.pathname);
			if (route === null) {
				setState({ status: "select", environments: catalog.environments });
				return;
			}
			const target = catalog.environments.find(
				(environment) => environment.environmentId === route.environmentId,
			);
			if (target === undefined) {
				setState({
					status: "error",
					description:
						"This computer is not linked to your account. It may have been removed.",
				});
				return;
			}
			await registerHostedClient();
			await connectHostedEnvironment(route.environmentId);
			setState({ status: "ready" });
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			setState({
				status: "error",
				description:
					reason === "computer_limit_reached"
						? "This account has reached its served-computer limit."
						: reason === "version_incompatible"
							? "This computer needs a Zuse Serve update before it can connect."
							: "Check that the computer is online, then try again.",
			});
		}
	}, []);
	useEffect(() => {
		void connect();
	}, [connect]);
	if (state.status !== "ready") {
		return <HostedAccessCard retry={() => void connect()} state={state} />;
	}
	return (
		<>
			{children}
			<ConnectionBanner />
		</>
	);
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
