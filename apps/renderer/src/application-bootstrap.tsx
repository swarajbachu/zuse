import { lazy, Suspense } from "react";
import { StartupSurface } from "./components/startup-surface.tsx";

const Application = lazy(() =>
	import("./application.tsx").then((module) => ({
		default: module.Application,
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
			<Application />
		</Suspense>
	);
}
