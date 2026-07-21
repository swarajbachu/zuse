import type { EditorView } from "@codemirror/view";
import { useLayoutEffect, useState } from "react";

export interface ComposerAnchorRect {
	readonly left: number;
	/** Distance from the viewport bottom to just above the composer card. */
	readonly bottom: number;
	readonly width: number;
}

/**
 * Fixed-position anchor for popovers that portal out of the composer.
 * They must escape the composer's backdrop-filter root — a nested
 * backdrop blur cannot sample the page, so glass only works from a
 * body-level portal.
 */
export function useComposerAnchor(view: EditorView): ComposerAnchorRect | null {
	const [rect, setRect] = useState<ComposerAnchorRect | null>(null);
	useLayoutEffect(() => {
		const host = view.dom.closest("[data-slot=card]") ?? view.dom;
		const update = () => {
			const r = host.getBoundingClientRect();
			setRect({
				left: r.left,
				bottom: window.innerHeight - r.top + 6,
				width: r.width,
			});
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(host);
		window.addEventListener("resize", update);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [view]);
	return rect;
}
