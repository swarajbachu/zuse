import { lazy, Suspense } from "react";

const Application = lazy(() =>
	import("./application.tsx").then((module) => ({
		default: module.Application,
	})),
);

export function ApplicationBootstrapFallback() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading Zuse"
			className="h-dvh w-screen bg-background text-foreground"
			role="status"
		>
			<span className="sr-only">Loading Zuse</span>
		</div>
	);
}

export function ApplicationBootstrap() {
	return (
		<Suspense fallback={<ApplicationBootstrapFallback />}>
			<Application />
		</Suspense>
	);
}
