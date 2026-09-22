import "@zuse/i18n/english/chat";
import type { SurfacePhase } from "@zuse/client-runtime/resource-state";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";

import { LogoTraceLoader } from "./logo-trace-loader.tsx";

export const SLOW_STARTUP_DELAY_MS = 4_000;

export type StartupPresentation = "loading" | "error" | "ready";

const STARTUP_ERROR_MAX_LENGTH = 800;

export const sanitizeStartupError = (error: string | null): string | null => {
	if (error === null) return null;
	const sanitized = error
		.replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]+\b/g, "[redacted]")
		.replace(
			/([?&](?:access_token|api_key|code|password|secret|token)=)[^&\s]+/gi,
			"$1[redacted]",
		)
		.replace(/file:\/\/\/[^\s)?]+/g, "[local path]")
		.replace(/\/(?:Users|home)\/[^\s:)?]+/g, "[local path]")
		.replace(/[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s:)?]+/g, "[local path]")
		.trim();
	if (sanitized.length === 0) return null;
	return sanitized.slice(0, STARTUP_ERROR_MAX_LENGTH);
};

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
	loading,
	onDone,
	phase,
	onRetry,
}: {
	readonly error: string | null;
	readonly loading?: boolean;
	readonly onDone?: () => void;
	readonly phase: SurfacePhase;
	readonly onRetry: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const presentation = startupPresentation({ loaded: false, phase });
	const activelyLoading = presentation === "loading" && loading !== false;
	const [slow, setSlow] = useState(false);
	const [copied, setCopied] = useState(false);
	const safeError = sanitizeStartupError(error);

	useEffect(() => {
		if (!activelyLoading) {
			setSlow(false);
			return;
		}
		const timeout = window.setTimeout(
			() => setSlow(true),
			SLOW_STARTUP_DELAY_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [activelyLoading]);

	const copyDetails = () => {
		if (safeError === null) return;
		void navigator.clipboard?.writeText(safeError).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	};

	return (
		<div
			aria-busy={activelyLoading}
			className="fixed inset-0 z-50 flex h-dvh max-h-dvh min-h-0 w-screen items-center justify-center overflow-hidden bg-background px-6 text-foreground"
		>
			{presentation === "loading" ? (
				<main aria-live="polite" className="flex flex-col items-center gap-3">
					<LogoTraceLoader
						ariaLabel={uiMessage("chat:startup_surface_loading_zuse")}
						className="text-foreground"
						loading={activelyLoading}
						onDone={onDone}
						size={72}
					/>
					{slow ? (
						<p className="text-muted-foreground text-xs">
							{uiMessage("chat:startup_surface_still_starting_zuse")}
						</p>
					) : null}
				</main>
			) : (
				<main
					aria-labelledby="startup-error-title"
					className="w-full max-w-sm text-center"
				>
					<div className="font-semibold text-base tracking-tight">
						{uiMessage("chat:startup_surface_zuse")}
					</div>
					<h1 id="startup-error-title" className="mt-4 font-medium text-sm">
						{uiMessage("chat:startup_surface_zuse_couldn_t_start")}
					</h1>
					<p className="mt-1 text-muted-foreground text-xs leading-5">
						{uiMessage(
							"chat:startup_surface_the_local_server_did_not_become_available_your_data_is_still_on_disk",
						)}
					</p>
					{safeError === null ? null : (
						<p
							className="mt-3 break-words text-muted-foreground text-xs"
							role="alert"
						>
							{safeError}
						</p>
					)}
					<div className="mt-4 flex items-center justify-center gap-2">
						<button
							className="inline-flex h-7 items-center justify-center rounded-md bg-primary px-2.5 font-medium text-primary-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={onRetry}
							type="button"
						>
							{uiMessage("chat:startup_surface_try_again")}
						</button>
						<button
							className="inline-flex h-7 items-center justify-center rounded-md bg-muted px-2.5 font-medium text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => window.location.reload()}
							type="button"
						>
							{uiMessage("chat:startup_surface_reload")}
						</button>
						{safeError === null ? null : (
							<button
								className="inline-flex h-7 items-center justify-center rounded-md px-2.5 font-medium text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onClick={copyDetails}
								type="button"
							>
								{copied
									? uiMessage("common:copied")
									: uiMessage("chat:startup_surface_copy_details")}
							</button>
						)}
					</div>
				</main>
			)}
		</div>
	);
}
