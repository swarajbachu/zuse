import "@zuse/i18n/english/errors";
import { message as uiMessage } from "@zuse/i18n";
import {
	LocalizationProvider,
	useMessages as useUiMessages,
} from "@zuse/i18n/react";
import { Suspense } from "react";
import { initializeLocalization } from "./lib/localization.ts";
import "./lib/crypto-compatibility.ts";

import React from "react";
import ReactDOM from "react-dom/client";

import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { ApplicationBootstrap } from "./application-bootstrap.tsx";
import { ErrorBoundary } from "./components/ui/error-boundary.tsx";
import { recoverDevModule } from "./lib/dev-module-recovery.ts";
import {
	installRendererDiagnostics,
	persistFatalRendererDiagnostic,
	recordDiagnosticEvent,
	recordReactCommit,
	summarizeDiagnosticError,
} from "./lib/diagnostics-recorder.ts";

if (import.meta.env.DEV) {
	const onPreloadError = (event: Event) => {
		if (recoverDevModule((event as Event & { payload?: unknown }).payload))
			event.preventDefault();
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		if (recoverDevModule(event.reason)) event.preventDefault();
	};
	window.addEventListener("vite:preloadError", onPreloadError);
	window.addEventListener("unhandledrejection", onRejection);
	import.meta.hot?.dispose(() => {
		window.removeEventListener("vite:preloadError", onPreloadError);
		window.removeEventListener("unhandledrejection", onRejection);
	});
	void import("./lib/update-demo.ts").then((m) => m.installUpdateDemo());
}

installRendererDiagnostics();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing in index.html");

function formatCrashDetails(error: Error, componentStack?: string): string {
	return [
		`${error.name}: ${error.message}`,
		error.stack ?? "",
		componentStack ? `React component stack:\n${componentStack}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

const sanitizedComponentDiagnostics = (componentStack?: string): string =>
	componentStack ? `React component stack:\n${componentStack}` : "";

function RootCrashFallback({ error }: { readonly error: Error }) {
	const { message: uiMessage } = useUiMessages(["common", "errors"]);

	const details = formatCrashDetails(error);
	const copyDetails = () => {
		void navigator.clipboard?.writeText(details);
	};

	return (
		<div className="flex h-dvh w-screen items-center justify-center bg-background px-6 text-foreground">
			<main
				aria-labelledby="root-crash-title"
				className="w-full max-w-[560px] rounded-lg border border-border/70 bg-card p-6 shadow-xs"
			>
				<div className="space-y-2">
					<p className="font-medium text-destructive text-sm">
						{uiMessage("errors:main_renderer_crashed")}
					</p>
					<h1 id="root-crash-title" className="font-semibold text-xl">
						{uiMessage("errors:main_zuse_hit_a_ui_error")}
					</h1>
					<p className="text-muted-foreground text-sm">
						{uiMessage(
							"errors:main_your_local_data_is_still_on_disk_reload_the_window_or_copy_these_crash",
						)}
					</p>
				</div>
				<pre className="mt-4 max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/60 p-3 text-muted-foreground text-xs leading-5">
					{details}
				</pre>
				<div className="mt-5 flex flex-wrap gap-2">
					<button
						className="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-3 font-medium text-primary-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
						type="button"
						onClick={() => window.location.reload()}
					>
						{uiMessage("errors:main_reload")}
					</button>
					<button
						className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-muted px-3 font-medium text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
						type="button"
						onClick={copyDetails}
					>
						{uiMessage("errors:main_copy_crash_details")}
					</button>
				</div>
			</main>
		</div>
	);
}

void initializeLocalization().then(() =>
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<LocalizationProvider>
				<Suspense
					fallback={<div role="status">{uiMessage("common:loading")}</div>}
				>
					<ErrorBoundary
						fallback={(error) => <RootCrashFallback error={error} />}
						onError={(error, info) => {
							recoverDevModule(error);
							persistFatalRendererDiagnostic("renderer.react.root", error);
							const summary = summarizeDiagnosticError(error, "ReactError");
							recordDiagnosticEvent({
								level: "error",
								source: "renderer.react.root",
								message: summary.message,
								detail: [
									summary.detail,
									sanitizedComponentDiagnostics(info.componentStack),
								]
									.filter(Boolean)
									.join("\n\n"),
							});
						}}
					>
						{import.meta.env.DEV ? (
							<React.Profiler
								id="app.root"
								onRender={(id, phase, actualDuration, baseDuration) => {
									recordReactCommit(id, phase, actualDuration, baseDuration);
								}}
							>
								<ApplicationBootstrap />
							</React.Profiler>
						) : (
							<ApplicationBootstrap />
						)}
					</ErrorBoundary>
				</Suspense>
			</LocalizationProvider>
		</React.StrictMode>,
	),
);
