type NativeEndScroller = {
	readonly scrollToEnd?: (options?: { readonly animated?: boolean }) => void;
};

type ListEndScroller = {
	readonly getNativeScrollRef: () => unknown;
	readonly scrollToEnd: (options?: {
		readonly animated?: boolean;
	}) => Promise<void>;
};

const afterNextLayout = (): Promise<void> =>
	new Promise((resolve) => requestAnimationFrame(() => resolve()));

const nativeEndScroller = (value: unknown): NativeEndScroller | null => {
	if (
		(value === null || typeof value !== "object") &&
		typeof value !== "function"
	) {
		return null;
	}
	if (!("scrollToEnd" in value)) return null;
	const scrollToEnd = value.scrollToEnd;
	return typeof scrollToEnd === "function"
		? { scrollToEnd: scrollToEnd.bind(value) }
		: null;
};

export const finishNativeEndScroll = async (
	list: Pick<ListEndScroller, "getNativeScrollRef">,
	options: {
		readonly animated: boolean;
		readonly afterVirtualLayout?: () => Promise<void>;
	},
): Promise<void> => {
	await (options.afterVirtualLayout ?? afterNextLayout)();
	nativeEndScroller(list.getNativeScrollRef())?.scrollToEnd?.({
		animated: options.animated,
	});
};

/**
 * Lets the virtual list mount and measure the destination, then finishes on the
 * keyboard-aware native scroll range after its animated inset has committed.
 */
export const scrollListToLatest = async (
	list: ListEndScroller,
	options: {
		readonly animated: boolean;
		readonly afterVirtualLayout?: () => Promise<void>;
	},
): Promise<void> => {
	// LegendList can leave its animated imperative promise pending when iOS
	// emits no momentum-end event. Start virtualization, but never put the
	// native keyboard-aware fallback behind that promise.
	void list.scrollToEnd({ animated: options.animated }).catch(() => undefined);
	await finishNativeEndScroll(list, options);
};
