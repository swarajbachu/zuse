export type TranscriptAnchorReadyInfo = {
	readonly anchorIndex: number | undefined;
};

export type TranscriptScrollSnapshot = {
	readonly anchorIndex: number | null;
	readonly pendingJumpRequestId: number | null;
	readonly readerDetached: boolean;
};

type TranscriptScrollActions = {
	readonly onScrollFailed: () => void;
	readonly releaseFreeze: () => void;
	readonly scrollAnchoredMessageToEnd: () => Promise<void>;
	readonly scrollToLatest: () => Promise<void>;
};

/**
 * Owns the ordering between React commits, measured list geometry, and native
 * imperative scrolls. Keeping this state outside the screen prevents layout
 * callbacks and reader gestures from racing separate effects.
 */
export class TranscriptScrollCoordinator {
	private actions: TranscriptScrollActions;
	private anchorRequestId = 0;
	private anchorScrollStartedForRequest = 0;
	private jumpRequestId = 0;
	private listeners = new Set<() => void>();
	private operationTail = Promise.resolve();
	private readerDetachedBeforeAppend: boolean | null = null;
	private scrollOperationActive = false;
	private snapshot: TranscriptScrollSnapshot;

	constructor(
		actions: TranscriptScrollActions,
		{ readerDetached = false }: { readonly readerDetached?: boolean } = {},
	) {
		this.actions = actions;
		this.snapshot = {
			anchorIndex: null,
			pendingJumpRequestId: null,
			readerDetached,
		};
	}

	getSnapshot = (): TranscriptScrollSnapshot => this.snapshot;
	isReaderDetached = (): boolean => this.snapshot.readerDetached;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	updateActions(actions: Partial<TranscriptScrollActions>): void {
		this.actions = { ...this.actions, ...actions };
	}

	onMessageWillAppend = (preAppendTurnCount: number): void => {
		this.readerDetachedBeforeAppend = this.snapshot.readerDetached;
		this.anchorRequestId += 1;
		this.anchorScrollStartedForRequest = 0;
		this.updateSnapshot({
			anchorIndex: preAppendTurnCount,
			pendingJumpRequestId: null,
			readerDetached: false,
		});
	};

	onAnchorReady = async (info: TranscriptAnchorReadyInfo): Promise<void> => {
		const { anchorIndex } = this.snapshot;
		const requestId = this.anchorRequestId;
		if (
			anchorIndex === null ||
			info.anchorIndex !== anchorIndex ||
			this.anchorScrollStartedForRequest === requestId
		) {
			return;
		}

		// Mark the request before awaiting so duplicate native layout callbacks
		// cannot dispatch a second scroll while the first is in flight.
		this.anchorScrollStartedForRequest = requestId;
		return this.enqueueScroll(async () => {
			if (
				this.anchorRequestId !== requestId ||
				this.snapshot.anchorIndex !== anchorIndex
			) {
				return;
			}
			try {
				await this.actions.scrollAnchoredMessageToEnd();
			} catch {
				if (this.anchorRequestId !== requestId) return;
				try {
					await this.actions.scrollAnchoredMessageToEnd();
				} catch {
					if (this.anchorRequestId !== requestId) return;
					this.clearAnchor();
					this.updateSnapshot({ ...this.snapshot, readerDetached: true });
					this.actions.onScrollFailed();
				}
			}
		});
	};

	onMessageAppendFailed = (): void => {
		const readerDetached =
			this.readerDetachedBeforeAppend ?? this.snapshot.readerDetached;
		this.readerDetachedBeforeAppend = null;
		this.clearAnchor();
		this.updateSnapshot({ ...this.snapshot, readerDetached });
		if (!this.scrollOperationActive) this.actions.releaseFreeze();
	};

	onTurnSettled = (): void => {
		this.readerDetachedBeforeAppend = null;
		const hadAnchor = this.snapshot.anchorIndex !== null;
		this.clearAnchor();
		if (hadAnchor && !this.scrollOperationActive) this.actions.releaseFreeze();
	};

	onReaderDetached = (): void => {
		this.readerDetachedBeforeAppend = null;
		this.anchorRequestId += 1;
		this.anchorScrollStartedForRequest = 0;
		this.updateSnapshot({
			...this.snapshot,
			anchorIndex: null,
			readerDetached: true,
		});
	};

	onFollowingRequested = (): void => {
		this.readerDetachedBeforeAppend = null;
		if (!this.snapshot.readerDetached) return;
		this.updateSnapshot({ ...this.snapshot, readerDetached: false });
	};

	requestJump = (): void => {
		this.readerDetachedBeforeAppend = null;
		this.anchorRequestId += 1;
		this.anchorScrollStartedForRequest = 0;
		this.jumpRequestId += 1;
		this.updateSnapshot({
			anchorIndex: null,
			pendingJumpRequestId: this.jumpRequestId,
			readerDetached: false,
		});
	};

	commitPendingJump = async (requestId: number | null): Promise<void> => {
		if (
			requestId === null ||
			this.snapshot.pendingJumpRequestId !== requestId
		) {
			return;
		}

		// Consuming before awaiting gives every jump request exactly-once
		// semantics even if React runs another layout effect meanwhile.
		this.updateSnapshot({
			...this.snapshot,
			pendingJumpRequestId: null,
		});
		return this.enqueueScroll(async () => {
			if (requestId !== this.jumpRequestId) return;
			try {
				await this.actions.scrollToLatest();
			} catch {
				this.updateSnapshot({ ...this.snapshot, readerDetached: true });
				this.actions.onScrollFailed();
			}
		});
	};

	private clearAnchor(): void {
		this.anchorRequestId += 1;
		this.anchorScrollStartedForRequest = 0;
		if (this.snapshot.anchorIndex === null) return;
		this.updateSnapshot({ ...this.snapshot, anchorIndex: null });
	}

	private updateSnapshot(next: TranscriptScrollSnapshot): void {
		if (
			next.anchorIndex === this.snapshot.anchorIndex &&
			next.pendingJumpRequestId === this.snapshot.pendingJumpRequestId &&
			next.readerDetached === this.snapshot.readerDetached
		) {
			return;
		}
		this.snapshot = next;
		for (const listener of this.listeners) listener();
	}

	private enqueueScroll(operation: () => Promise<void>): Promise<void> {
		const run = async () => {
			this.scrollOperationActive = true;
			try {
				await operation();
			} finally {
				this.actions.releaseFreeze();
				this.scrollOperationActive = false;
			}
		};
		const queued = this.operationTail.then(run, run);
		this.operationTail = queued.catch(() => undefined);
		return queued;
	}
}
