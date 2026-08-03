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

export function resolveTimelineHasContentBelowViewport(
	state: TimelineListMeasurementState | null | undefined,
	occludedEnd = 0,
): boolean {
	if (state === null || state === undefined || state.data.length === 0) {
		return false;
	}
	const lastIndex = state.data.length - 1;
	const top = state.positionAtIndex(lastIndex);
	const size = state.sizeAtIndex(lastIndex);
	if (
		typeof top !== "number" ||
		typeof size !== "number" ||
		!Number.isFinite(top) ||
		!Number.isFinite(size)
	) {
		return false;
	}
	const visibleBottom =
		state.scroll + Math.max(0, state.scrollLength - Math.max(0, occludedEnd));
	return top + size > visibleBottom + 2;
}
