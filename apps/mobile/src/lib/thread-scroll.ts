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

export const pendingThreadScrollCommand = (options: {
	readonly pendingJumpToEnd: boolean;
	readonly anchorActive: boolean;
}): "jump-end" | "wait" | "none" => {
	if (!options.pendingJumpToEnd) return "none";
	return options.anchorActive ? "wait" : "jump-end";
};
