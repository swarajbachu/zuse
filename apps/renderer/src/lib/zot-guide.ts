import type { ZotOnboardingStep } from "../store/zot-onboarding.ts";

/** Controls the Zot guide can point at, marked with `data-zot-guide`. */
export type ZotGuideTarget =
	| "identity"
	| "repositories"
	| "brief"
	| "slaves"
	| "continuity";

export const ZOT_GUIDE_ATTRIBUTE = "data-zot-guide";

/** The welcome step introduces the Zot itself: its name in the header. */
export const ZOT_GUIDE_TARGETS: Readonly<
	Record<ZotOnboardingStep, ZotGuideTarget>
> = {
	welcome: "identity",
	repositories: "repositories",
	brief: "brief",
	slaves: "slaves",
	continuity: "continuity",
};

/** Example briefs offered in the empty Zot and on the brief step. */
export const ZOT_EXAMPLE_BRIEFS = ["delegate", "tests", "reviews"] as const;
export type ZotExampleBrief = (typeof ZOT_EXAMPLE_BRIEFS)[number];

type GuideElement = Pick<HTMLElement, "closest" | "getClientRects">;

/**
 * The marked control inside this Zot surface, or `null` when it isn't
 * mounted, is hidden, or sits in an inert (slid-away) panel. Callers fall
 * back to an unanchored card.
 */
export const findZotGuideTarget = <Element extends GuideElement>(
	root: { querySelector: (selector: string) => Element | null } | null,
	target: ZotGuideTarget | null,
): Element | null => {
	if (!root || !target) return null;
	const element = root.querySelector(`[${ZOT_GUIDE_ATTRIBUTE}="${target}"]`);
	if (!element || element.closest("[inert]")) return null;
	return element.getClientRects().length > 0 ? element : null;
};

type RailStore = {
	getState: () => {
		readonly railOpen: boolean | null;
		readonly setRailOpen: (open: boolean) => void;
	};
	subscribe: (
		listener: (state: { readonly railOpen: boolean | null }) => void,
	) => () => void;
};

/**
 * Opens a closed Details panel for the whole guide, so the layout doesn't
 * shift between steps. `release` closes it again only
 * if the guide opened it and nobody has changed it since. Ownership is judged
 * by value, so it holds whether the store notifies synchronously or later.
 */
export const leaseDetailsPanel = (store: RailStore) => {
	let owned = false;
	const unsubscribe = store.subscribe((state) => {
		if (state.railOpen !== true) owned = false;
	});
	return {
		acquire: () => {
			if (store.getState().railOpen !== false) return;
			owned = true;
			store.getState().setRailOpen(true);
		},
		release: () => {
			unsubscribe();
			if (owned && store.getState().railOpen === true)
				store.getState().setRailOpen(false);
			owned = false;
		},
	};
};

type ExampleBridge = {
	readonly draftKey: string | null;
	readonly insertText: ((text: string) => void) | null;
};

/** Whether the example can go into this Zot's own composer, and nowhere else. */
export const canInsertZotExample = (
	bridge: ExampleBridge,
	draftKey: string | null,
): boolean =>
	draftKey !== null &&
	bridge.draftKey === draftKey &&
	bridge.insertText !== null;

/**
 * Adds the example brief at the cursor as editable text, keeping any draft.
 * It is never sent.
 */
export const insertZotExample = (
	bridge: ExampleBridge,
	draftKey: string | null,
	text: string,
): boolean => {
	if (!canInsertZotExample(bridge, draftKey)) return false;
	bridge.insertText?.(text);
	return true;
};

/**
 * Whether the guide card shows now. A guide that was already open when the
 * surface mounted (first use or resume) waits while this Zot's conversation
 * is on screen but its composer hasn't registered yet: the composer focuses
 * itself on mount, so showing after it lets the card take focus. With no
 * composer to expect (no coordinator, History, Preferences) and for replays,
 * it shows at once.
 */
export const zotGuideVisible = ({
	open,
	waitForComposer,
	draftKey,
	bridgeDraftKey,
}: {
	readonly open: boolean;
	/** Automatic open while the conversation, and so the composer, is mounted. */
	readonly waitForComposer: boolean;
	readonly draftKey: string | null;
	readonly bridgeDraftKey: string | null;
}): boolean =>
	open &&
	(!waitForComposer || draftKey === null || bridgeDraftKey === draftKey);

type Focusable = { readonly focus: () => void };

/**
 * After the guide closes with focus lost to the page, returns it to this
 * Zot's composer, or else to the header More button inside the same surface.
 * Focus the user has already moved elsewhere is left alone.
 */
export const restoreZotGuideFocus = (
	focusLost: boolean,
	root: { querySelector: (selector: string) => Focusable | null } | null,
	bridge: {
		readonly draftKey: string | null;
		readonly focus: (() => void) | null;
	},
	draftKey: string | null,
): "kept" | "composer" | "more" | "none" => {
	if (!focusLost) return "kept";
	if (draftKey !== null && bridge.draftKey === draftKey && bridge.focus) {
		bridge.focus();
		return "composer";
	}
	const more = root?.querySelector(`[${ZOT_GUIDE_ATTRIBUTE}="continuity"]`);
	if (!more) return "none";
	more.focus();
	return "more";
};
