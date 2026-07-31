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
