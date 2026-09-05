import type { Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

import { openExternal } from "../platform-capabilities";
import { hostnameFromLink } from "../site-favicon";
import { mountSiteFavicon } from "../site-favicon-dom";
import { knownSiteLink } from "../site-link";

const cleanups = new WeakMap<HTMLElement, () => void>();

class ComposerLinkWidget extends WidgetType {
	constructor(
		readonly url: string,
		readonly label: string | null,
	) {
		super();
	}
	eq(other: ComposerLinkWidget): boolean {
		return (
			this.label === other.label &&
			(this.label === null
				? hostnameFromLink(this.url) === hostnameFromLink(other.url)
				: this.url === other.url)
		);
	}
	toDOM(view: EditorView): HTMLElement {
		const icon = document.createElement("span");
		icon.className = "site-favicon composer-link-favicon";
		icon.setAttribute("aria-hidden", "true");
		const cleanup = mountSiteFavicon(icon, this.url);
		if (this.label === null) {
			cleanups.set(icon, cleanup);
			return icon;
		}
		const link = document.createElement("a");
		link.className = "composer-link composer-link-widget";
		link.href = this.url;
		link.title = `${this.url}\nAlt-click to edit link`;
		link.setAttribute(
			"aria-label",
			`${this.label} (${hostnameFromLink(this.url)})`,
		);
		link.onmousedown = (event) => event.preventDefault();
		link.onclick = (event) => {
			event.preventDefault();
			if (event.altKey) {
				view.dispatch({ selection: { anchor: view.posAtDOM(link) + 1 } });
				view.focus();
			} else {
				void openExternal(this.url);
			}
		};
		const label = document.createElement("span");
		label.className = "composer-link-label";
		label.textContent = this.label;
		link.append(icon, label);
		cleanups.set(link, cleanup);
		return link;
	}
	destroy(dom: HTMLElement): void {
		cleanups.get(dom)?.();
		cleanups.delete(dom);
	}
	ignoreEvent(): boolean {
		return this.label !== null;
	}
}

/** Only the presentation changes; editing, copying and sending use the full URL. */
export const composerLinkDecorations = (
	view: Pick<EditorView, "state" | "visibleRanges">,
): DecorationSet => {
	const ranges: Range<Decoration>[] = [];
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/giu)) {
			const url = match[0].replace(/[.,;:!?\])}]+$/u, "");
			if (hostnameFromLink(url) === null) continue;
			const start = from + match.index;
			const end = start + url.length;
			const editing = view.state.selection.ranges.some(
				({ anchor, head }) =>
					(anchor > start && anchor < end) || (head > start && head < end),
			);
			if (editing) {
				ranges.push(
					Decoration.widget({
						widget: new ComposerLinkWidget(url, null),
						side: -1,
					}).range(start),
					Decoration.mark({ class: "composer-link" }).range(start, end),
				);
			} else {
				ranges.push(
					Decoration.replace({
						widget: new ComposerLinkWidget(
							url,
							knownSiteLink(url)?.label ?? url,
						),
					}).range(start, end),
				);
			}
		}
	}
	return Decoration.set(ranges, true);
};

export const composerLinks = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = composerLinkDecorations(view);
		}
		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged || update.selectionSet) {
				this.decorations = composerLinkDecorations(update.view);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);
