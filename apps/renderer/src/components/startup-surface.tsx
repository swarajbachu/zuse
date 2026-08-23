import type { SurfacePhase } from "@zuse/client-runtime/resource-state";
import { useEffect, useState } from "react";

import { Spinner } from "./ui/spinner.tsx";

export const SLOW_STARTUP_DELAY_MS = 4_000;

export type StartupPresentation = "loading" | "error" | "ready";

export const startupPresentation = (input: {
	readonly loaded: boolean;
	readonly phase: SurfacePhase;
}): StartupPresentation => {
	if (input.loaded) return "ready";
	return input.phase === "error" ||
		input.phase === "blocked-auth" ||
		input.phase === "update-required"
		? "error"
		: "loading";
};

export function StartupSurface({
	error,
	phase,
	onRetry,
}: {
	readonly error: string | null;
	readonly phase: SurfacePhase;
	readonly onRetry: () => void;
}) {
	const presentation = startupPresentation({ loaded: false, phase });
	const [slow, setSlow] = useState(false);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (presentation !== "loading") {
			setSlow(false);
			return;
		}
		const timeout = window.setTimeout(
			() => setSlow(true),
			SLOW_STARTUP_DELAY_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [presentation]);

	const copyDetails = () => {
		if (error === null) return;
		void navigator.clipboard?.writeText(error).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	};

	return (
		<div
			aria-busy={presentation === "loading"}
			className="flex h-dvh max-h-dvh min-h-0 w-screen items-center justify-center overflow-hidden bg-background px-6 text-foreground"
		>
			{presentation === "loading" ? (
				<main
					aria-label="Loading Zuse"
					aria-live="polite"
					className="flex flex-col items-center gap-3"
					role="status"
				>
					<div className="font-semibold text-base tracking-tight">Zuse</div>
					<Spinner className="size-4 text-muted-foreground" />
					{slow ? (
						<p className="text-muted-foreground text-xs">
							Still starting Zuse…
						</p>
					) : null}
				</main>
			) : (
				<main
					aria-labelledby="startup-error-title"
					className="w-full max-w-sm text-center"
				>
					<div className="font-semibold text-base tracking-tight">Zuse</div>
					<h1 id="startup-error-title" className="mt-4 font-medium text-sm">
						Zuse couldn’t start
					</h1>
					<p className="mt-1 text-muted-foreground text-xs leading-5">
						The local server did not become available. Your data is still on
						disk.
					</p>
					{error === null ? null : (
						<p
							className="mt-3 break-words text-muted-foreground text-xs"
							role="alert"
						>
							{error}
						</p>
					)}
					<div className="mt-4 flex items-center justify-center gap-2">
						<button
							className="inline-flex h-7 items-center justify-center rounded-md bg-primary px-2.5 font-medium text-primary-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={onRetry}
							type="button"
						>
							Try again
						</button>
						<button
							className="inline-flex h-7 items-center justify-center rounded-md bg-muted px-2.5 font-medium text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => window.location.reload()}
							type="button"
						>
							Reload
						</button>
						{error === null ? null : (
							<button
								className="inline-flex h-7 items-center justify-center rounded-md px-2.5 font-medium text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onClick={copyDetails}
								type="button"
							>
								{copied ? "Copied" : "Copy details"}
							</button>
						)}
					</div>
				</main>
			)}
		</div>
	);
}
