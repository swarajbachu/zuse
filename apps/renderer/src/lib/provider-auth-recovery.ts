export interface ProviderAuthRecoveryActions {
	readonly reopen: () => Promise<boolean>;
	readonly retry: () => Promise<boolean>;
	readonly resumeQueue: () => Promise<void>;
}

/**
 * Reconnect the provider before releasing any durable user intent.
 *
 * Existing chats already have a persisted user turn to retry. Fresh chats
 * instead hold their first prompt in the startup queue, so a retry correctly
 * reports false and recovery releases that queue item.
 */
export const resumeAfterProviderLogin = async (
	actions: ProviderAuthRecoveryActions,
): Promise<boolean> => {
	if (!(await actions.reopen())) return false;
	if (!(await actions.retry())) {
		await actions.resumeQueue();
	}
	return true;
};
