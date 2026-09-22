import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserAccessGate } from "./components/browser-access-gate.tsx";
import {
	StartupSurface,
	startupPresentation,
} from "./components/startup-surface.tsx";
import { AppearanceController } from "./lib/appearance.tsx";
import { markRendererStartupMilestone } from "./lib/performance-marks.ts";
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
	const presentation =
		settingsPresentation === "ready" && !applicationReady
			? "loading"
			: settingsPresentation;
	useEffect(() => {
		onStartupStateChange?.({
			presentation,
			error: settings.error,
			retry: settings.retry,
		});
	}, [onStartupStateChange, presentation, settings.error, settings.retry]);

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
