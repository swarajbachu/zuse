import { lazy, Suspense } from "react";
import { StartupSurface } from "./components/startup-surface.tsx";

const StartupApplication = lazy(() =>
	import("./startup-application.tsx").then((module) => ({
		default: module.StartupApplication,
	})),
);

export function ApplicationBootstrapFallback() {
	return (
		<StartupSurface error={null} phase="initial-loading" onRetry={() => {}} />
	);
}

export function ApplicationBootstrap() {
	return (
		<Suspense fallback={<ApplicationBootstrapFallback />}>
			<StartupApplication />
		</Suspense>
	);
}
