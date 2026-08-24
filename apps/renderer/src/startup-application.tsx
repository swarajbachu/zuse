import { lazy, Suspense, useEffect } from "react";
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

export function StartupApplication() {
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

	if (startupPresentation(settings) !== "ready") {
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
				<StartupSurface
					error={null}
					phase="initial-loading"
					onRetry={settings.retry}
				/>
			}
		>
			<Application />
		</Suspense>
	);
}
