import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, ProviderId, SessionId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { LinkSquare01Icon, Logout03Icon } from "@zuse/icons/stroke-rounded";

import {
	composerOwnsProviderSignIn,
	isComposerSignInError,
	latestProviderAuthFailureAt,
	resumeAfterProviderLogin,
} from "../../lib/provider-auth-recovery.ts";
import { PROVIDER_LABEL } from "../../lib/provider-labels.ts";
import {
	clearSessionCommandError,
	pendingSessionCommandError,
	resumeSessionQueue,
	sessionCommandErrorKey,
	useSessionCommandErrors,
} from "../../lib/session-actions.ts";
import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import {
	openExternal,
	useProviderLogin,
} from "../../lib/use-provider-login.ts";
import { useProvidersStore } from "../../store/providers.ts";
import { useSessionsStore } from "../../store/sessions.ts";
import { Spinner } from "../ui/spinner.tsx";
import { TrayPill, trayPillTextActionClass } from "./tray-pill.tsx";

/**
 * Above-composer sign-in notice for a local provider whose credentials expired
 * or were removed. The transcript only records that the provider signed out;
 * recovery lives here, next to where the user continues the chat. Signing in
 * reopens the session so an interrupted durable turn and any queued prompt
 * resume with the fresh credentials.
 */
export function ProviderSignInTray({
	sessionId,
	environmentId,
	providerId,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	providerId: ProviderId;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const timeline = useRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);
	const ref = timeline.ref;
	const errorKey = sessionCommandErrorKey(ref);
	const localError = useSessionCommandErrors(
		(state) => state.errorByResource[errorKey] ?? null,
	);
	const commandError = localError ?? pendingSessionCommandError(ref);
	const refreshProviders = useProvidersStore((s) => s.refresh);
	const reopenSession = useSessionsStore((s) => s.resume);
	const { state, signedInAt, start, cancel } = useProviderLogin(providerId, {
		environmentId,
		onSuccess: () => {
			// Re-probe first so the credential write has landed, then reopen the
			// provider and release a fresh chat's queued first message.
			void (async () => {
				await refreshProviders();
				const resumed = await resumeAfterProviderLogin({
					reopen: () => reopenSession(sessionId, environmentId),
					resumeQueue: () => resumeSessionQueue(ref, providerId),
				});
				if (resumed) clearSessionCommandError(ref);
			})();
		},
	});

	if (!composerOwnsProviderSignIn(providerId, environmentId)) return null;
	const failedAt = latestProviderAuthFailureAt(timeline.messages);
	const signedOut =
		(failedAt !== null && failedAt.getTime() > signedInAt) ||
		(commandError !== null &&
			isComposerSignInError(commandError, providerId, environmentId));
	if (!signedOut && state.kind !== "waiting" && state.kind !== "success")
		return null;

	const label = String(PROVIDER_LABEL[providerId]);
	const busy = state.kind === "waiting" || state.kind === "success";
	const subtitle =
		state.kind === "waiting"
			? state.url === null
				? uiMessage("chat:message_row_starting_sign_in", { label })
				: uiMessage("chat:message_row_waiting_for_browser_sign_in")
			: state.kind === "success"
				? uiMessage("chat:message_row_signed_in_finishing")
				: state.kind === "failed"
					? state.reason
					: uiMessage("chat:provider_sign_in_tray_sign_in_to_continue");

	return (
		<TrayPill
			flush
			role="status"
			aria-live="polite"
			icon={
				busy ? (
					<Spinner className="size-3.5 motion-reduce:animate-none" />
				) : (
					<HugeiconsIcon icon={Logout03Icon} className="size-3.5" />
				)
			}
			title={uiMessage("chat:provider_sign_in_tray_signed_out", { label })}
			subtitle={subtitle}
			actions={
				state.kind === "waiting" ? (
					<>
						{state.url !== null ? (
							<button
								type="button"
								className={trayPillTextActionClass}
								onClick={() => {
									if (state.url !== null) openExternal(state.url);
								}}
							>
								<HugeiconsIcon icon={LinkSquare01Icon} className="size-3.5" />
								{uiMessage("chat:message_row_open_browser_again")}
							</button>
						) : null}
						<button
							type="button"
							className={trayPillTextActionClass}
							onClick={cancel}
						>
							{uiMessage("common:cancel")}
						</button>
					</>
				) : state.kind === "success" ? null : (
					<button
						type="button"
						className={trayPillTextActionClass}
						onClick={() => void start()}
					>
						{state.kind === "failed"
							? uiMessage("common:retry")
							: uiMessage("common:signIn")}
					</button>
				)
			}
		/>
	);
}
