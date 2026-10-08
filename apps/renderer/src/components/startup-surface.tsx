import "@zuse/i18n/english/common";
import type { SurfacePhase } from "@zuse/client-runtime/resource-state";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";

import { AccessScreen } from "./access-screen.tsx";
import { Button } from "./ui/button.tsx";

export const SLOW_STARTUP_DELAY_MS = 4_000;

const SURFACE_CLASS_NAME = "fixed inset-0 z-50 h-dvh max-h-dvh min-h-0";

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
	const { message: uiMessage } = useUiMessages(["common"]);

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

	if (presentation === "loading") {
		return (
			<AccessScreen
				className={SURFACE_CLASS_NAME}
				description={
					slow
						? uiMessage("common:startup_surface_still_starting_zuse")
						: undefined
				}
				loaderComplete={!activelyLoading}
				loaderLabel={uiMessage("common:startup_surface_loading_zuse")}
				loading
				onLoaderDone={onDone}
			/>
		);
	}

	return (
		<AccessScreen
			className={SURFACE_CLASS_NAME}
			description={uiMessage(
				"common:startup_surface_the_local_server_did_not_become_available_your_data_is_still_on_disk",
			)}
			footer={
				safeError === null ? undefined : (
					<p className="break-words font-mono" role="alert">
						{safeError}
					</p>
				)
			}
			headingId="startup-error-title"
			loaderLabel={uiMessage("common:startup_surface_zuse")}
			loading={false}
			title={uiMessage("common:startup_surface_zuse_couldn_t_start")}
		>
			<div className="flex gap-2">
				<Button className="flex-1" onClick={onRetry}>
					{uiMessage("common:startup_surface_try_again")}
				</Button>
				<Button
					className="flex-1"
					onClick={() => window.location.reload()}
					variant="outline"
				>
					{uiMessage("common:startup_surface_reload")}
				</Button>
				{safeError === null ? null : (
					<Button onClick={copyDetails} variant="ghost">
						{copied
							? uiMessage("common:copied")
							: uiMessage("common:startup_surface_copy_details")}
					</Button>
				)}
			</div>
		</AccessScreen>
	);
}
