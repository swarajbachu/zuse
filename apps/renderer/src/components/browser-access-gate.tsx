import "@zuse/i18n/english/shell";
import { parseEnvironmentRoute } from "@zuse/client-runtime/environment-scope";
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
import { PreSettingsAppearanceController } from "../lib/appearance-mode.tsx";
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
	watchHostedAccountChanges,
} from "../lib/hosted-connect.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import {
	retryRendererRpcConnection,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import { AccessScreen } from "./access-screen.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

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
		<AccessScreen
			description={
				loading
					? uiMessage(
							"shell:browser_access_gate_authentication_and_connection_recovery_happen_automatically",
						)
					: state.description
			}
			footer={
				!loading && state.pairingAllowed
					? uiMessage(
							"shell:browser_access_gate_enter_the_code_shown_on_the_other_computer_in_its_serve_terminal_or_se",
						)
					: undefined
			}
			headingRef={headingRef}
			loaderLabel={uiMessage(
				"shell:browser_access_gate_connecting_to_your_environment",
			)}
			loading={loading}
			title={
				loading
					? uiMessage(
							"shell:browser_access_gate_connecting_to_your_environment",
						)
					: state.title
			}
		>
			{!loading && state.pairingAllowed ? (
				<form className="flex flex-col gap-2" onSubmit={submitPairing}>
					<label className="font-medium text-xs" htmlFor="pairing-code">
						{uiMessage("shell:browser_access_gate_pairing_code")}
					</label>
					<div className="flex gap-2">
						<Input
							aria-invalid={pairingError !== null || undefined}
							autoCapitalize="characters"
							autoComplete="one-time-code"
							className="flex-1 font-mono uppercase tracking-widest"
							disabled={pairing}
							id="pairing-code"
							maxLength={256}
							onChange={(event) => setCode(event.target.value)}
							placeholder={uiMessage("shell:browser_access_gate_abcd_efgh")}
							spellCheck={false}
							value={code}
						/>
						<Button
							disabled={code.trim().length === 0}
							loading={pairing}
							type="submit"
						>
							{uiMessage("common:connect")}
						</Button>
					</div>
					{pairingError !== null ? (
						<p className="text-destructive text-xs" role="alert">
							{pairingError}
						</p>
					) : null}
				</form>
			) : !loading && state.retryable ? (
				<Button className="w-full" onClick={retry}>
					{uiMessage("shell:browser_access_gate_try_again")}
				</Button>
			) : undefined}
		</AccessScreen>
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

	const [redirecting, setRedirecting] = useState<"sign-in" | "sign-up" | null>(
		null,
	);
	const [signInError, setSignInError] = useState<string | null>(null);
	const startSignIn = (screenHint: "sign-in" | "sign-up") => {
		setRedirecting(screenHint);
		setSignInError(null);
		beginHostedSignIn(screenHint).catch(() => {
			setRedirecting(null);
			setSignInError(uiMessage("shell:hosted_connection_retry"));
		});
	};
	const loading = state.status === "loading";
	return (
		<AccessScreen
			description={
				state.status === "loading"
					? uiMessage("shell:hosted_signing_in_to_your_cloud_workspace")
					: state.status === "signedOut"
						? uiMessage(
								"shell:hosted_sign_in_to_set_up_cloud_agents_connect_repositories_and_start_chatting",
							)
						: state.description
			}
			loaderLabel={uiMessage("shell:hosted_opening_zuse")}
			loading={loading}
			title={
				state.status === "loading"
					? uiMessage("shell:hosted_opening_zuse")
					: state.status === "signedOut"
						? uiMessage("shell:hosted_your_cloud_agents_anywhere")
						: uiMessage("shell:hosted_could_not_open_zuse")
			}
		>
			{state.status === "signedOut" ? (
				<>
					<Button
						className="w-full"
						disabled={redirecting !== null}
						loading={redirecting === "sign-in"}
						onClick={() => startSignIn("sign-in")}
					>
						{uiMessage("common:signIn")}
					</Button>
					<Button
						className="w-full"
						disabled={redirecting !== null}
						loading={redirecting === "sign-up"}
						onClick={() => startSignIn("sign-up")}
						variant="outline"
					>
						{uiMessage("shell:hosted_create_account")}
					</Button>
					{signInError !== null ? (
						<p className="text-destructive text-xs" role="alert">
							{signInError}
						</p>
					) : null}
				</>
			) : state.status === "error" ? (
				<Button className="w-full" onClick={retry}>
					{uiMessage("shell:browser_access_gate_try_again")}
				</Button>
			) : undefined}
		</AccessScreen>
	);
}

export const resolveHostedAccess = async (
	pathname: string,
): Promise<HostedAccessState> => {
	const completedSignIn = await completeHostedSignIn();
	const targetPath = completedSignIn ? window.location.pathname : pathname;
	if (!(await hostedSignedIn())) return { status: "signedOut" };
	const route = parseEnvironmentRoute(targetPath);
	if (route !== null) {
		const catalog = await listHostedEnvironments();
		if (
			!catalog.environments.some(
				(environment) => environment.environmentId === route.environmentId,
			)
		)
			return {
				status: "error",
				description: uiMessage(
					"shell:browser_access_gate_this_computer_is_not_linked_to_your_account_it_may_have_been_remo",
				),
			};
	}
	await registerHostedClient();
	if (route !== null) await connectHostedEnvironment(route.environmentId);
	else if (targetPath.startsWith("/w/")) {
		const { openCloudChatLink } = await import("../lib/cloud-chat-link.ts");
		await openCloudChatLink(targetPath);
	}
	return { status: "ready" };
};

function HostedAccessGate({ children }: { readonly children: ReactNode }) {
	const [state, setState] = useState<HostedAccessState>({
		status: "loading",
	});
	const connect = useCallback(async () => {
		setState({ status: "loading" });
		try {
			setState(await resolveHostedAccess(window.location.pathname));
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			setState({
				status: "error",
				description:
					reason === "chat_link_unavailable"
						? uiMessage("shell:chat_link_unavailable")
						: reason === "chat_link_update_required"
							? uiMessage("shell:chat_link_update_required")
							: reason === "computer_limit_reached"
								? "This account has reached its served-computer limit."
								: reason === "version_incompatible"
									? "This computer needs a Zuse Serve update before it can connect."
									: uiMessage("shell:hosted_connection_retry"),
			});
		}
	}, []);
	useEffect(() => {
		void connect();
		return watchHostedAccountChanges();
	}, [connect]);
	if (state.status !== "ready") {
		return (
			<>
				<PreSettingsAppearanceController />
				<HostedAccessCard retry={() => void connect()} state={state} />
			</>
		);
	}
	return (
		<>
			{children}
			{parseEnvironmentRoute(window.location.pathname) !== null ? (
				<ConnectionBanner />
			) : null}
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
			<>
				<PreSettingsAppearanceController />
				<AccessCard pair={pair} retry={() => void connect()} state={state} />
			</>
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
