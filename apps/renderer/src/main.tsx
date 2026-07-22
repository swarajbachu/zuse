import React from "react";
import ReactDOM from "react-dom/client";

import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { App } from "./app";
import { BrowserAccessGate } from "./components/browser-access-gate.tsx";
import { ErrorBoundary } from "./components/ui/error-boundary.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import {
	installRendererDiagnostics,
	recordDiagnosticEvent,
} from "./lib/diagnostics-recorder.ts";
import { AppAtomProvider } from "./state/registry.tsx";

if (import.meta.env.DEV) {
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

function RootCrashFallback({ error }: { readonly error: Error }) {
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
						Renderer crashed
					</p>
					<h1 id="root-crash-title" className="font-semibold text-xl">
						Zuse hit a UI error.
					</h1>
					<p className="text-muted-foreground text-sm">
						Your local data is still on disk. Reload the window, or copy these
						crash details for debugging.
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
						Reload
					</button>
					<button
						className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-muted px-3 font-medium text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
						type="button"
						onClick={copyDetails}
					>
						Copy crash details
					</button>
				</div>
			</main>
		</div>
	);
}

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<ErrorBoundary
			fallback={(error) => <RootCrashFallback error={error} />}
			onError={(error, info) => {
				recordDiagnosticEvent({
					level: "error",
					source: "renderer.react.root",
					message: `${error.name}: ${error.message}`,
					detail: formatCrashDetails(error, info.componentStack),
				});
			}}
		>
			<AppAtomProvider>
				<ToastProvider>
					<BrowserAccessGate>
						<App />
					</BrowserAccessGate>
				</ToastProvider>
			</AppAtomProvider>
		</ErrorBoundary>
	</React.StrictMode>,
);
