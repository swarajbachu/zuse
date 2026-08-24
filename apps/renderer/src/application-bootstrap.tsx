import { type ComponentType, useEffect, useState } from "react";
import { StartupSurface } from "./components/startup-surface.tsx";

const STARTUP_APPLICATION_TIMEOUT_MS = 15_000;

const loadStartupApplication = () =>
	import("./startup-application.tsx").then((module) => ({
		StartupApplication: module.StartupApplication,
	}));

type BootstrapState =
	| { readonly status: "loading" }
	| {
			readonly status: "ready";
			readonly Application: ComponentType;
	  }
	| { readonly status: "error"; readonly error: string };

export function ApplicationBootstrap() {
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<BootstrapState>({ status: "loading" });

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

	if (state.status === "ready") return <state.Application />;
	return (
		<StartupSurface
			error={state.status === "error" ? state.error : null}
			phase={state.status === "error" ? "error" : "initial-loading"}
			onRetry={() => setAttempt((current) => current + 1)}
		/>
	);
}
