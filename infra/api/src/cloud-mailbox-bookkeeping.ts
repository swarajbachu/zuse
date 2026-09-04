import type { CloudMailboxLifecycleFence } from "./cloud-workspace-store.ts";

const MAILBOX_BOOKKEEPING_TIMEOUT_MS = 5_000;

/** Keep post-lease control-plane bookkeeping off the lease response path. */
export const mailboxBookkeepingWithDeadline = <Value>(
	operation: Promise<Value>,
	timeoutMs = MAILBOX_BOOKKEEPING_TIMEOUT_MS,
): Promise<Value> =>
	new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("cloud mailbox bookkeeping timed out")),
			timeoutMs,
		);
		operation.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});

export const drainMailboxLifecycleOutbox = async (input: {
	readonly list: () => Promise<ReadonlyArray<CloudMailboxLifecycleFence>>;
	readonly deliver: (lifecycle: CloudMailboxLifecycleFence) => Promise<boolean>;
	readonly acknowledge: (
		lifecycle: CloudMailboxLifecycleFence,
	) => Promise<boolean>;
	readonly onFailure?: (
		lifecycle: CloudMailboxLifecycleFence,
		cause: unknown,
	) => void;
}): Promise<number> => {
	const pending = await input.list();
	let delivered = 0;
	for (const lifecycle of pending) {
		try {
			if (!(await input.deliver(lifecycle))) continue;
			if (await input.acknowledge(lifecycle)) delivered += 1;
		} catch (cause) {
			input.onFailure?.(lifecycle, cause);
		}
	}
	return delivered;
};

/** Lifecycle delivery is independent recovery work and must survive reconcile faults. */
export const reconcileCloudThenDrainMailboxLifecycleOutbox = async (input: {
	readonly reconcile: () => Promise<unknown>;
	readonly drain: () => Promise<number>;
	readonly onReconcileFailure?: (cause: unknown) => void;
}): Promise<number> => {
	// Start delivery independently so a slow provider reconciliation cannot hold
	// already-committed destructive fences hostage.
	const drain = input.drain();
	try {
		await input.reconcile();
	} catch (cause) {
		input.onReconcileFailure?.(cause);
	}
	return drain;
};
