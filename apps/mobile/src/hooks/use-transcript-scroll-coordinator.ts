import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import { TranscriptScrollCoordinator } from "~/lib/transcript-scroll-coordinator";

type UseTranscriptScrollCoordinatorOptions = {
	readonly initiallyDetached?: boolean;
	readonly onScrollFailed: () => void;
	readonly releaseFreeze: () => void;
	readonly scrollAnchoredMessageToEnd: () => Promise<void>;
	readonly scrollToLatest: () => Promise<void>;
};

export function useTranscriptScrollCoordinator(
	options: UseTranscriptScrollCoordinatorOptions,
) {
	const [coordinator] = useState(
		() =>
			new TranscriptScrollCoordinator(options, {
				readerDetached: options.initiallyDetached,
			}),
	);
	const snapshot = useSyncExternalStore(
		coordinator.subscribe,
		coordinator.getSnapshot,
		coordinator.getSnapshot,
	);

	useLayoutEffect(() => {
		coordinator.updateActions(options);
	}, [coordinator, options]);

	useLayoutEffect(() => {
		void coordinator.commitPendingJump(snapshot.pendingJumpRequestId);
	}, [coordinator, snapshot.pendingJumpRequestId]);

	return {
		anchorIndex: snapshot.anchorIndex,
		isReaderDetached: coordinator.isReaderDetached,
		onAnchorReady: coordinator.onAnchorReady,
		onComposerBlurred: coordinator.onComposerBlurred,
		onComposerLayout: coordinator.onComposerLayout,
		onFollowingRequested: coordinator.onFollowingRequested,
		onMessageAppendFailed: coordinator.onMessageAppendFailed,
		onMessageWillAppend: coordinator.onMessageWillAppend,
		onReaderDetached: coordinator.onReaderDetached,
		onTurnSettled: coordinator.onTurnSettled,
		readerDetached: snapshot.readerDetached,
		requestJump: coordinator.requestJump,
	};
}
