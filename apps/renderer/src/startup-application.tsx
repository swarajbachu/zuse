import "@zuse/i18n/english/settings";
import { useMessages } from "@zuse/i18n/react";
import {
	lazy,
	Suspense,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { BrowserAccessGate } from "./components/browser-access-gate.tsx";
import {
	StartupSurface,
	startupPresentation,
} from "./components/startup-surface.tsx";
import { AppearanceController } from "./lib/appearance.tsx";
import { markRendererStartupMilestone } from "./lib/performance-marks.ts";
import {
	rendererWorkspaceSnapshot,
	selectRendererWorkspace,
	subscribeRendererWorkspace,
} from "./lib/renderer-workspace.ts";
import { useSettingsStore } from "./lib/settings-client-bus.ts";

const Application = lazy(() =>
	import("./application.tsx").then((module) => ({
		default: module.Application,
	})),
);

export type StartupStateSnapshot = {
	readonly presentation: "loading" | "error" | "ready";
	readonly error: string | null;
	readonly retry: () => void;
};

export function StartupApplication({
	onStartupStateChange,
}: {
	readonly onStartupStateChange?: (state: StartupStateSnapshot) => void;
}) {
	return (
		<BrowserAccessGate>
			<ConnectedStartupApplication
				onStartupStateChange={onStartupStateChange}
			/>
		</BrowserAccessGate>
	);
}

function ConnectedStartupApplication({
	onStartupStateChange,
}: {
	readonly onStartupStateChange?: (state: StartupStateSnapshot) => void;
}) {
	const { message } = useMessages(["common", "settings"]);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const settings = useSettingsStore((state) => ({
		error: state.error,
		loaded: state.loaded,
		origin: state.origin,
		phase: state.phase,
		retry: state.retry,
	}));
	useEffect(() => {
		if (settings.phase === "synchronizing" || settings.phase === "live") {
			markRendererStartupMilestone("rpc-connected");
		}
		if (!settings.loaded) return;
		markRendererStartupMilestone(
			settings.origin === "cache" ? "settings-cache-hydrated" : "settings-live",
		);
	}, [settings.loaded, settings.origin, settings.phase]);
	const [applicationReady, setApplicationReady] = useState(false);
	const settingsPresentation = startupPresentation(settings);
	// A workspace API failure is not a failed local server. Keep an escape route
	// without rendering workspace content with missing (or Personal) settings.
	const workspacePending =
		workspace.scope.kind === "organization" && settingsPresentation !== "ready";
	const presentation = workspacePending
		? "ready"
		: settingsPresentation === "ready" && !applicationReady
			? "loading"
			: settingsPresentation;
	// Offer a way back to Personal only if a first organization load is slow.
	const [workspaceSlow, setWorkspaceSlow] = useState(false);
	useEffect(() => {
		setWorkspaceSlow(false);
		if (!workspacePending) return;
		const timer = window.setTimeout(() => setWorkspaceSlow(true), 5_000);
		return () => window.clearTimeout(timer);
	}, [workspacePending, workspace]);
	useEffect(() => {
		onStartupStateChange?.({
			presentation,
			error: settings.error,
			retry: settings.retry,
		});
	}, [onStartupStateChange, presentation, settings.error, settings.retry]);

	if (workspacePending) {
		// Only the first visit to an organization on this device waits here;
		// later switches render its cached settings immediately.
		return (
			<>
				<AppearanceController />
				<div className="flex h-dvh items-center justify-center bg-background text-foreground">
					{settings.error === null ? (
						<div className="flex flex-col items-center gap-3">
							<p role="status" className="text-xs text-muted-foreground">
								{message("common:workspace_loading")}
							</p>
							{workspaceSlow && (
								<button
									type="button"
									className="h-7 rounded-md bg-muted px-2.5 text-xs focus-visible:outline focus-visible:outline-ring"
									onClick={() => selectRendererWorkspace({ kind: "personal" })}
								>
									{message("settings:workspace_personal")}
								</button>
							)}
						</div>
					) : (
						<div className="max-w-sm space-y-3 px-6 text-center text-sm">
							<p role="alert">{settings.error}</p>
							<div className="flex justify-center gap-2">
								<button
									type="button"
									className="h-7 rounded-md bg-primary px-2.5 text-xs text-primary-foreground focus-visible:outline focus-visible:outline-ring"
									onClick={settings.retry}
								>
									{message("common:retry")}
								</button>
								<button
									type="button"
									className="h-7 rounded-md bg-muted px-2.5 text-xs focus-visible:outline focus-visible:outline-ring"
									onClick={() => selectRendererWorkspace({ kind: "personal" })}
								>
									{message("settings:workspace_personal")}
								</button>
							</div>
						</div>
					)}
				</div>
			</>
		);
	}

	if (settingsPresentation !== "ready") {
		if (onStartupStateChange !== undefined) return <AppearanceController />;
		return (
			<>
				<AppearanceController />
				<StartupSurface
					error={settings.error}
					phase={settings.phase}
					onRetry={settings.retry}
				/>
			</>
		);
	}

	return (
		<Suspense
			fallback={
				onStartupStateChange === undefined ? (
					<StartupSurface
						error={null}
						phase="initial-loading"
						onRetry={settings.retry}
					/>
				) : null
			}
		>
			<Application onReady={() => setApplicationReady(true)} />
		</Suspense>
	);
}
