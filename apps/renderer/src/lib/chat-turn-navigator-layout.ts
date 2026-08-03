export const CHAT_TURN_NAVIGATOR_MIN_WIDTH = 640;
export const CHAT_TURN_NAVIGATOR_MIN_HEIGHT = 384;
export const CHAT_TURN_LIST_VERTICAL_PADDING = 8;

/**
 * The navigator is optional chrome. Hide it before it can cover the transcript
 * or composer instead of squeezing a full desktop control into a narrow pane.
 */
export function canShowChatTurnNavigator({
	width,
	height,
}: {
	readonly width: number;
	readonly height: number;
}): boolean {
	return (
		Number.isFinite(width) &&
		Number.isFinite(height) &&
		width >= CHAT_TURN_NAVIGATOR_MIN_WIDTH &&
		height >= CHAT_TURN_NAVIGATOR_MIN_HEIGHT
	);
}

export function resolveChatTurnListHeight({
	turnCount,
	rowHeight,
	maxHeight,
}: {
	readonly turnCount: number;
	readonly rowHeight: number;
	readonly maxHeight: number;
}): number {
	return Math.min(
		Math.max(0, maxHeight),
		Math.max(0, turnCount) * Math.max(0, rowHeight) +
			CHAT_TURN_LIST_VERTICAL_PADDING,
	);
}
