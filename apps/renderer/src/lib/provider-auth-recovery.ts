import type { EnvironmentId, Message, ProviderId } from "@zuse/contracts";

import { isCloudWorkspaceEnvironment } from "./rpc-client.ts";
import { type ChatError, classifyErrorContent } from "./session-actions.ts";
import { supportsProviderLogin } from "./use-provider-login.ts";

export interface ProviderAuthRecoveryActions {
	readonly reopen: () => Promise<boolean>;
	readonly resumeQueue: () => Promise<void>;
}

/**
 * Reconnect the provider before releasing any durable user intent.
 *
 * Reopen replays an active durable turn itself. Releasing the queue afterward
 * is safe: active sessions remain held, while a fresh dormant session can send
 * its first queued prompt. A second renderer-side retry would duplicate turns.
 */
export const resumeAfterProviderLogin = async (
	actions: ProviderAuthRecoveryActions,
): Promise<boolean> => {
	if (!(await actions.reopen())) return false;
	await actions.resumeQueue();
	return true;
};

/**
 * Local providers with an in-app sign-in are recovered from the composer's
 * sign-in tray, so the transcript only states that the provider signed out.
 * Cloud workspaces keep their own account-level recovery card.
 */
export const composerOwnsProviderSignIn = (
	providerId: ProviderId | undefined,
	environmentId: EnvironmentId | undefined,
): providerId is ProviderId =>
	providerId !== undefined &&
	environmentId !== undefined &&
	supportsProviderLogin(providerId) &&
	!isCloudWorkspaceEnvironment(environmentId);

export const isComposerSignInError = (
	error: ChatError,
	providerId: ProviderId | undefined,
	environmentId: EnvironmentId | undefined,
): boolean =>
	error.kind === "auth" &&
	composerOwnsProviderSignIn(error.providerId ?? providerId, environmentId);

// Bookkeeping rows a provider can append after a failed turn; they neither
// resolve nor restate the failure.
const PASSIVE_CONTENT = new Set<Message["content"]["_tag"]>([
	"usage",
	"context_usage",
	"usage_limit",
	"subagent_progress",
]);

/**
 * When the transcript currently ends on a provider sign-in failure, the time it
 * was recorded. Any later user or agent activity means the session moved on.
 */
export const latestProviderAuthFailureAt = (
	messages: ReadonlyArray<Message>,
): Date | null => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined) break;
		const content = message.content;
		if (PASSIVE_CONTENT.has(content._tag)) continue;
		if (content._tag !== "error") return null;
		return classifyErrorContent(content).kind === "auth"
			? message.createdAt
			: null;
	}
	return null;
};
