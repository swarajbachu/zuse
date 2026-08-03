export interface TimelineListMeasurementState {
	readonly data: readonly unknown[];
	readonly scroll: number;
	readonly scrollLength: number;
	readonly positionAtIndex: (index: number) => number | undefined;
	readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface TimelineScrollableNodeState {
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

export interface AnchoredTurnMetrics {
	readonly anchorTop: number;
	readonly lastBottom: number;
	readonly turnHeight: number;
	readonly usableViewportHeight: number;
	readonly visibleUsableBottom: number;
	readonly overflowsUsableViewport: boolean;
	readonly targetScrollToRevealEnd: number;
	readonly scrollDeltaToRevealEnd: number;
}

// Following resumes only at the true live edge. A wider "near end" band can
// pull a reader back after a small intentional scroll.
const LIVE_EDGE_TOLERANCE_PX = 2;

export function resolveScrollableNodeIsAtEnd(
	node: TimelineScrollableNodeState | null | undefined,
	threshold = LIVE_EDGE_TOLERANCE_PX,
): boolean | undefined {
	if (node === null || node === undefined) return undefined;
	const { scrollTop, scrollHeight, clientHeight } = node;
	if (
		!Number.isFinite(scrollTop) ||
		!Number.isFinite(scrollHeight) ||
		!Number.isFinite(clientHeight)
	) {
		return undefined;
	}

	return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function getRowBottom(
	state: TimelineListMeasurementState,
	index: number,
): number | null {
	const top = state.positionAtIndex(index);
	const height = state.sizeAtIndex(index);
	if (
		typeof top !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(top) ||
		!Number.isFinite(height)
	) {
		return null;
	}

	return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
	state,
	anchorIndex,
	composerOverlayHeight,
	anchorOffset,
}: {
	readonly state: TimelineListMeasurementState;
	readonly anchorIndex: number;
	readonly composerOverlayHeight: number;
	readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
	if (state.data.length === 0) return null;

	const boundedAnchorIndex = Math.max(
		0,
		Math.min(anchorIndex, state.data.length - 1),
	);
	const anchorTop = state.positionAtIndex(boundedAnchorIndex);
	const lastBottom = getRowBottom(state, state.data.length - 1);
	if (
		typeof anchorTop !== "number" ||
		!Number.isFinite(anchorTop) ||
		lastBottom === null
	) {
		return null;
	}

	const usableViewportHeight = Math.max(
		0,
		state.scrollLength - composerOverlayHeight - anchorOffset,
	);
	const turnHeight = Math.max(0, lastBottom - anchorTop);
	const visibleUsableBottom = state.scroll + usableViewportHeight;
	const targetScrollToRevealEnd = Math.max(
		0,
		lastBottom - usableViewportHeight,
	);
	const scrollDeltaToRevealEnd = Math.max(
		0,
		targetScrollToRevealEnd - state.scroll,
	);

	return {
		anchorTop,
		lastBottom,
		turnHeight,
		usableViewportHeight,
		visibleUsableBottom,
		overflowsUsableViewport: turnHeight > usableViewportHeight,
		targetScrollToRevealEnd,
		scrollDeltaToRevealEnd,
	};
}
