export type ThreadScrollMode = "initial" | "following" | "detached";

export type ThreadScrollEvent =
	| { readonly type: "initial-positioned" }
	| { readonly type: "reader-interacted" }
	| { readonly type: "returned-to-live-edge"; readonly distance: number }
	| { readonly type: "message-submitted" }
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
 * Reserve only the unused part of the latest-turn viewport. As the response
 * grows, this space shrinks by the same amount, so the turn remains anchored
 * without manually compensating the list offset.
 */
export const latestTurnAnchorSpace = (options: {
	readonly viewportHeight: number;
	readonly bottomInset: number;
	readonly latestTurnHeight: number;
	readonly previousContext: number;
}): number =>
	Math.max(
		0,
		options.viewportHeight -
			Math.max(0, options.bottomInset) -
			Math.max(0, options.latestTurnHeight) -
			Math.max(0, options.previousContext),
	);
