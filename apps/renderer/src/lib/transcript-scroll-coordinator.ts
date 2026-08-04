import { CHAT_LIST_ANCHOR_OFFSET } from "./chat-list-anchor.ts";
import type { TimelineListMeasurementState } from "./timeline-scroll-anchoring.ts";

export type TranscriptScrollMode =
	| "restoring"
	| "following"
	| "anchoring-turn"
	| "detached"
	| "navigating";

export interface TranscriptScrollSnapshot {
	readonly mode: TranscriptScrollMode;
	readonly isAtEnd: boolean;
}

export interface TranscriptScrollAdapter {
	readonly getMeasurementState: () => TimelineListMeasurementState | null;
	readonly isAtLiveEdge: () => boolean | undefined;
	readonly scrollToEnd: (options: {
		readonly animated: boolean;
	}) => void | Promise<void>;
	readonly scrollToIndex: (options: {
		readonly index: number;
		readonly viewOffset: number;
		readonly animated: boolean;
	}) => void | Promise<void>;
}

type PendingCommand =
	| {
			readonly kind: "end";
			readonly animated: boolean;
			readonly priority: 1 | 3;
			readonly completionGeneration?: number;
			readonly settleAttempts?: number;
	  }
	| {
			readonly kind: "turn";
			readonly index: number;
			readonly viewOffset: number;
			readonly animated: boolean;
			readonly priority: 3;
			readonly completionGeneration?: number;
			readonly settleAttempts?: number;
	  };

export interface TranscriptScrollCoordinatorOptions {
	readonly scheduleFrame?: (callback: () => void) => number;
	readonly cancelFrame?: (id: number) => void;
	readonly onChange?: (snapshot: TranscriptScrollSnapshot) => void;
}

const defaultScheduleFrame = (callback: () => void): number =>
	requestAnimationFrame(callback);
const defaultCancelFrame = (id: number): void => cancelAnimationFrame(id);

/**
 * The sole policy owner for transcript movement. LegendList remains responsible
 * for measurement and visible-content compensation; all semantic navigation and
 * live-follow writes pass through this coordinator and are serialized per frame.
 */
export class TranscriptScrollCoordinator {
	private adapter: TranscriptScrollAdapter | null = null;
	private snapshot: TranscriptScrollSnapshot = {
		mode: "restoring",
		isAtEnd: true,
	};
	private pending: PendingCommand | null = null;
	private frame: number | null = null;
	private allowLiveEdgeResume = true;
	private anchorIndex: number | null = null;
	private anchorOffset = CHAT_LIST_ANCHOR_OFFSET;
	private anchorPositioned = false;
	private navigationGeneration = 0;
	private readonly scheduleFrame: (callback: () => void) => number;
	private readonly cancelFrame: (id: number) => void;
	private readonly onChange: (snapshot: TranscriptScrollSnapshot) => void;

	constructor(options: TranscriptScrollCoordinatorOptions = {}) {
		this.scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
		this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
		this.onChange = options.onChange ?? (() => {});
	}

	attach(adapter: TranscriptScrollAdapter): void {
		this.adapter = adapter;
	}

	detach(): void {
		this.adapter = null;
		this.cancelPending();
	}

	getSnapshot(): TranscriptScrollSnapshot {
		return this.snapshot;
	}

	initialize(options: {
		readonly atReadingPosition: boolean;
		readonly isAtEnd?: boolean;
	}): void {
		this.cancelPending();
		this.anchorIndex = null;
		const isAtEnd = options.isAtEnd ?? !options.atReadingPosition;
		this.allowLiveEdgeResume = !options.atReadingPosition || isAtEnd;
		this.update({
			mode: options.atReadingPosition && !isAtEnd ? "detached" : "following",
			isAtEnd,
		});
	}

	prepareNewTurn(index: number, anchorOffset = CHAT_LIST_ANCHOR_OFFSET): void {
		this.anchorIndex = index;
		this.anchorOffset = anchorOffset;
		this.anchorPositioned = false;
		this.allowLiveEdgeResume = false;
		this.update({ mode: "anchoring-turn", isAtEnd: false });
	}

	positionAnchoredTurn(options: {
		readonly animated: boolean;
		readonly force?: boolean;
	}): void {
		if (this.snapshot.mode !== "anchoring-turn" || this.anchorIndex === null) {
			return;
		}
		if (this.anchorPositioned && options.force !== true) return;
		this.anchorPositioned = true;
		this.enqueue({
			kind: "turn",
			index: this.anchorIndex,
			viewOffset: this.anchorOffset,
			animated: options.animated,
			priority: 3,
			settleAttempts: 4,
		});
	}

	contentChanged(): void {
		if (this.snapshot.mode === "following") {
			this.enqueue({ kind: "end", animated: false, priority: 1 });
			return;
		}
		// While a new turn is anchored, new response content is allowed to grow
		// below the viewport. Moving to reveal its end would move the prompt away
		// from the reading position the user explicitly established.
	}

	readerTookControl(intent: "interaction" | "scroll" = "interaction"): void {
		this.navigationGeneration += 1;
		this.cancelPending();
		this.anchorIndex = null;
		this.anchorPositioned = false;
		this.allowLiveEdgeResume = intent === "scroll";
		this.update({ mode: "detached", isAtEnd: this.snapshot.isAtEnd });
	}

	scrolled({ isAtEnd }: { readonly isAtEnd: boolean }): void {
		if (
			isAtEnd &&
			this.allowLiveEdgeResume &&
			this.snapshot.mode === "detached"
		) {
			this.update({ mode: "following", isAtEnd: true });
			return;
		}
		this.update({ mode: this.snapshot.mode, isAtEnd });
	}

	jumpToLatest(options: { readonly animated: boolean }): void {
		this.cancelPending();
		this.navigationGeneration += 1;
		const completionGeneration = this.navigationGeneration;
		this.anchorIndex = null;
		this.allowLiveEdgeResume = true;
		this.update({ mode: "navigating", isAtEnd: false });
		this.enqueue({
			kind: "end",
			animated: options.animated,
			priority: 3,
			completionGeneration,
			settleAttempts: 2,
		});
	}

	jumpToTurn(
		index: number,
		options: { readonly viewportOffset: number; readonly animated: boolean },
	): void {
		this.cancelPending();
		this.navigationGeneration += 1;
		this.anchorIndex = null;
		this.allowLiveEdgeResume = false;
		this.update({ mode: "navigating", isAtEnd: false });
		this.enqueue({
			kind: "turn",
			index,
			viewOffset: options.viewportOffset,
			animated: options.animated,
			priority: 3,
			completionGeneration: this.navigationGeneration,
			settleAttempts: 2,
		});
	}

	dispose(): void {
		this.cancelPending();
		this.adapter = null;
	}

	private update(snapshot: TranscriptScrollSnapshot): void {
		if (
			this.snapshot.mode === snapshot.mode &&
			this.snapshot.isAtEnd === snapshot.isAtEnd
		) {
			return;
		}
		this.snapshot = snapshot;
		this.onChange(snapshot);
	}

	private enqueue(command: PendingCommand): void {
		if (this.pending === null || command.priority >= this.pending.priority) {
			this.pending = command;
		}
		if (this.frame !== null) return;
		this.frame = this.scheduleFrame(() => {
			this.frame = null;
			const pending = this.pending;
			this.pending = null;
			if (pending !== null) this.execute(pending);
		});
	}

	private execute(command: PendingCommand): void {
		const adapter = this.adapter;
		if (adapter === null) return;
		switch (command.kind) {
			case "end":
				void Promise.resolve(
					adapter.scrollToEnd({ animated: command.animated }),
				)
					.then(() => {
						if (
							command.completionGeneration !== undefined &&
							command.completionGeneration === this.navigationGeneration &&
							this.snapshot.mode === "navigating"
						) {
							if (
								adapter.isAtLiveEdge() === false &&
								(command.settleAttempts ?? 0) > 0
							) {
								this.enqueue({
									...command,
									animated: false,
									settleAttempts: (command.settleAttempts ?? 0) - 1,
								});
								return;
							}
							if (adapter.isAtLiveEdge() === false) return;
							this.update({ mode: "following", isAtEnd: true });
						}
					})
					.catch(() => {
						// Keep the navigation affordance visible so the reader can retry.
					});
				return;
			case "turn":
				void Promise.resolve(
					adapter.scrollToIndex({
						index: command.index,
						viewOffset: command.viewOffset,
						animated: command.animated,
					}),
				)
					.then(() => {
						if (command.completionGeneration === undefined) {
							this.retryUnsettledAnchor(command, adapter);
							return;
						}
						if (
							command.completionGeneration !== this.navigationGeneration ||
							this.snapshot.mode !== "navigating"
						) {
							return;
						}
						const isAtEnd = adapter.isAtLiveEdge() === true;
						this.allowLiveEdgeResume = isAtEnd;
						this.update({
							mode: isAtEnd ? "following" : "detached",
							isAtEnd,
						});
					})
					.catch(() => {
						if (command.completionGeneration === undefined) {
							this.retryUnsettledAnchor(command, adapter, true);
							return;
						}
						if (
							command.completionGeneration !== this.navigationGeneration ||
							this.snapshot.mode !== "navigating" ||
							(command.settleAttempts ?? 0) <= 0
						) {
							return;
						}
						this.enqueue({
							...command,
							animated: false,
							settleAttempts: (command.settleAttempts ?? 0) - 1,
						});
					});
				return;
		}
	}

	private retryUnsettledAnchor(
		command: Extract<PendingCommand, { readonly kind: "turn" }>,
		adapter: TranscriptScrollAdapter,
		failed = false,
	): void {
		if (
			this.snapshot.mode !== "anchoring-turn" ||
			this.anchorIndex !== command.index
		) {
			return;
		}

		const state = adapter.getMeasurementState();
		const itemTop = state?.positionAtIndex(command.index);
		const settled =
			!failed &&
			state !== null &&
			typeof itemTop === "number" &&
			Number.isFinite(itemTop) &&
			Math.abs(itemTop - state.scroll - command.viewOffset) <= 2;
		if (settled || (command.settleAttempts ?? 0) <= 0) return;

		this.enqueue({
			...command,
			animated: false,
			settleAttempts: (command.settleAttempts ?? 0) - 1,
		});
	}

	private cancelPending(): void {
		this.pending = null;
		if (this.frame === null) return;
		this.cancelFrame(this.frame);
		this.frame = null;
	}
}
