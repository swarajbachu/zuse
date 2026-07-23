export type ThreadScrollMode = "initial" | "following" | "detached";

export type ThreadScrollEvent =
	| { readonly type: "initial-positioned" }
	| { readonly type: "reader-interacted" }
	| { readonly type: "returned-to-live-edge"; readonly distance: number }
	| { readonly type: "message-submitted" }
	| { readonly type: "jumped-to-latest" };

export type ThreadAnchorEvent =
	| { readonly type: "message-anchored"; readonly turnId: string }
	| { readonly type: "reader-interacted" }
	| { readonly type: "jumped-to-latest" };

/** Enter and leave thresholds are deliberately different to avoid edge flicker. */
export const LIVE_EDGE_ENTER_PX = 48;
export const LIVE_EDGE_EXIT_PX = 96;

export const nextThreadScrollMode = (
	mode: ThreadScrollMode,
	event: ThreadScrollEvent,
): ThreadScrollMode => {
	switch (event.type) {
		case "reader-interacted":
			return "detached";
		case "returned-to-live-edge":
			return event.distance <= LIVE_EDGE_ENTER_PX ? "following" : mode;
		case "initial-positioned":
		case "message-submitted":
		case "jumped-to-latest":
			return "following";
	}
};

export const nextThreadAnchor = (
	anchor: string | null,
	event: ThreadAnchorEvent,
): string | null => {
	switch (event.type) {
		case "message-anchored":
			return event.turnId;
		case "reader-interacted":
		case "jumped-to-latest":
			return null;
		default:
			return anchor;
	}
};

export const shouldFollowTranscript = (mode: ThreadScrollMode): boolean =>
	mode !== "detached";

export const shouldShowLatestAction = (options: {
	readonly mode: ThreadScrollMode;
	readonly distance: number;
	readonly hasUnseenContent: boolean;
}): boolean =>
	options.mode === "detached" &&
	(options.hasUnseenContent || options.distance > LIVE_EDGE_EXIT_PX);

export const transcriptBottomInset = (
	accessoryHeight: number,
	keyboardOverlap: number,
	spacing = 12,
): number =>
	Math.max(0, accessoryHeight) +
	Math.max(0, keyboardOverlap) +
	Math.max(0, spacing);

/**
 * Space reserved below the transcript while a send-anchor is active: always
 * exactly one "anchored viewport", so the anchored turn's top can sit at
 * headerOffset regardless of how tall the turn or the streaming reply becomes.
 * Independent of any turn-height measurement by design.
 */
export const sendAnchorSpace = (options: {
	readonly viewportHeight: number;
	readonly headerOffset: number;
	readonly bottomInset: number;
}): number =>
	Math.max(
		0,
		options.viewportHeight -
			Math.max(0, options.headerOffset) -
			Math.max(0, options.bottomInset),
	);

export type PendingThreadScrollCommand = "jump-end" | "send-anchor";

/**
 * Programmatic scrolls must wait for the footer state they depend on to be
 * reflected in FlatList's measured content size.
 */
export const pendingThreadScrollCommand = (options: {
	readonly pendingJumpToEnd: boolean;
	readonly pendingSendAnchor: boolean;
	readonly anchorActive: boolean;
}): PendingThreadScrollCommand | null => {
	if (options.pendingJumpToEnd) {
		return options.anchorActive ? null : "jump-end";
	}
	if (options.pendingSendAnchor) {
		return options.anchorActive ? "send-anchor" : null;
	}
	return null;
};
