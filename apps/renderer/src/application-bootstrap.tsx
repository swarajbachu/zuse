import { type ComponentType, useEffect, useState } from "react";
import { StartupSurface } from "./components/startup-surface.tsx";
import { rendererPlatformCapabilities } from "./lib/platform-capabilities.ts";
import type { StartupStateSnapshot } from "./startup-application.tsx";

const STARTUP_APPLICATION_TIMEOUT_MS = 15_000;

const loadStartupApplication = () =>
	import("./startup-application.tsx").then((module) => ({
		StartupApplication: module.StartupApplication,
	}));

type BootstrapState =
	| { readonly status: "loading" }
	| {
			readonly status: "ready";
			readonly Application: ComponentType<{
				readonly onStartupStateChange?: (state: StartupStateSnapshot) => void;
			}>;
	  }
	| { readonly status: "error"; readonly error: string };

export function ApplicationBootstrap() {
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<BootstrapState>({ status: "loading" });
	const [applicationState, setApplicationState] =
		useState<StartupStateSnapshot>({
			presentation: "loading",
			error: null,
			retry: () => {},
		});
	const [animationDone, setAnimationDone] = useState(false);
	const desktop = rendererPlatformCapabilities().desktop;

	useEffect(() => {
		let active = true;
		setState({ status: "loading" });
		const timeout = window.setTimeout(() => {
			if (!active) return;
			setState({
				status: "error",
				error: "The renderer startup module did not become ready in time.",
			});
		}, STARTUP_APPLICATION_TIMEOUT_MS);

		void loadStartupApplication().then(
			({ StartupApplication }) => {
				if (!active) return;
				window.clearTimeout(timeout);
				setState({ status: "ready", Application: StartupApplication });
			},
			(cause) => {
				if (!active) return;
				window.clearTimeout(timeout);
				setState({
					status: "error",
					error:
						cause instanceof Error
							? cause.message
							: "The renderer startup module could not be loaded.",
				});
			},
		);

		return () => {
			active = false;
			window.clearTimeout(timeout);
		};
	}, [attempt]);

	if (state.status === "ready" && !desktop) return <state.Application />;

	const applicationReady =
		state.status === "ready" && applicationState.presentation === "ready";
	const error =
		state.status === "error"
			? state.error
			: applicationState.presentation === "error"
				? applicationState.error
				: null;
	const retry =
		state.status === "error"
			? () => setAttempt((current) => current + 1)
			: applicationState.retry;

	return (
		<>
			{state.status === "ready" ? (
				<state.Application onStartupStateChange={setApplicationState} />
			) : null}
			{!applicationReady || !animationDone ? (
				<StartupSurface
					error={error}
					loading={!applicationReady}
					onDone={() => setAnimationDone(true)}
					onRetry={retry}
					phase={error === null ? "initial-loading" : "error"}
				/>
			) : null}
		</>
	);
}
