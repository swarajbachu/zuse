import type { IconSvgElement } from "@hugeicons/react";
import { FigmaIcon, GitlabIcon, NotionIcon } from "@zuse/icons/solid-rounded";
import { GITHUB_LOGO_PATH } from "./github-logo";
import { svgFromHugeicon } from "./icon-dom";
import { faviconUrlForLink, hostnameFromLink } from "./site-favicon";
import { type KnownSite, knownSiteLink } from "./site-link";

const SITE_ICONS: Partial<Record<KnownSite, IconSvgElement>> = {
	github: [
		["path", { d: GITHUB_LOGO_PATH, fill: "currentColor", key: "github" }],
	],
	gitlab: GitlabIcon,
	figma: FigmaIcon,
	notion: NotionIcon,
};

/** The same image loading and fallback behavior for React and CodeMirror. */
export const mountSiteFavicon = (
	host: HTMLElement,
	url: string,
): (() => void) => {
	const site = knownSiteLink(url)?.site;
	const icon = site === undefined ? undefined : SITE_ICONS[site];
	if (icon !== undefined) {
		host.replaceChildren(svgFromHugeicon(icon));
		return () => host.replaceChildren();
	}
	const fallback = () => {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		for (const [name, value] of Object.entries({
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
		}))
			svg.setAttribute(name, value);
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute(
			"d",
			"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
		);
		svg.append(path);
		host.replaceChildren(svg);
	};
	const image = document.createElement("img");
	image.alt = "";
	image.draggable = false;
	image.title = hostnameFromLink(url) ?? "";
	const src = faviconUrlForLink(url);
	if (src === null) {
		fallback();
	} else {
		image.onerror = fallback;
		image.src = src;
		host.replaceChildren(image);
	}
	return () => {
		image.onerror = null;
		host.replaceChildren();
	};
};
