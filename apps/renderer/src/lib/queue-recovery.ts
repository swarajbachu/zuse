import type { SessionRef } from "@zuse/client-runtime/resource-ref";

import { isPlatformOnline, subscribePlatformOnline } from "./network-status.ts";
import { resumeSessionQueue } from "./session-actions.ts";
import type { SessionRuntimeState } from "./session-runtime-state.ts";

export type QueueRecoveryInput = Readonly<{
	itemCount: number;
	paused: boolean;
	runtime: SessionRuntimeState;
	creationInProgress: boolean;
	waitingForSandbox: boolean;
}>;

/**
 * The server never drains a queue on its own once a turn settles in error, so
 * a held queue needs an explicit resume. Interrupts pause the queue; a failed
 * turn leaves it held without a pause flag.
 */
export const queueHoldReason = (
	input: Pick<QueueRecoveryInput, "paused" | "runtime">,
): "paused" | "failed" | null =>
	input.paused ? "paused" : input.runtime === "failed" ? "failed" : null;

/**
 * Whether the queue can be resumed without racing a live turn. Used both for
 * the tray's Resume pill and for the automatic resume on a network online edge.
 */
export const canResumeQueue = (input: QueueRecoveryInput): boolean =>
	input.itemCount > 0 &&
	!input.creationInProgress &&
	!input.waitingForSandbox &&
	input.runtime !== "running" &&
	input.runtime !== "stopping" &&
	input.runtime !== "starting";

const heldQueues = new Map<string, SessionRef>();
const heldKey = (ref: SessionRef): string =>
	`${ref.environmentId} ${ref.sessionId}`;

/**
 * Remember a queue that is waiting for the network. Messages queued while
 * offline skip the server's immediate flush, so something must resume them
 * once the platform is back online, even if the user has moved to another chat.
 */
export const holdQueueUntilOnline = (ref: SessionRef): void => {
	heldQueues.set(heldKey(ref), ref);
};

export const heldQueueRefsForTest = (): ReadonlyArray<SessionRef> => [
	...heldQueues.values(),
];

export const clearHeldQueuesForTest = (): void => {
	heldQueues.clear();
};

/** Resume every held queue on the next offline-to-online edge. */
export const installQueueOnlineRecovery = (
	resume: (ref: SessionRef) => Promise<void> = resumeSessionQueue,
): (() => void) => {
	let wasOnline = isPlatformOnline();
	return subscribePlatformOnline(() => {
		const nowOnline = isPlatformOnline();
		const cameOnline = nowOnline && !wasOnline;
		wasOnline = nowOnline;
		if (!cameOnline) return;
		const refs = [...heldQueues.values()];
		heldQueues.clear();
		for (const ref of refs) {
			void resume(ref).catch(() => {
				heldQueues.set(heldKey(ref), ref);
			});
		}
	});
};
