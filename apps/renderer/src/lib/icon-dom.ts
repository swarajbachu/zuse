import type { IconSvgElement } from "@hugeicons/react";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Vanilla-DOM render of a hugeicons glyph (for non-React hosts like CM). */
export const svgFromHugeicon = (icon: IconSvgElement): SVGSVGElement => {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("aria-hidden", "true");
	for (const [tag, attrs] of icon) {
		const el = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (key === "key") continue;
			// Icon data uses React camelCase props (strokeWidth, strokeLinecap);
			// raw DOM needs the kebab-case SVG attribute names.
			const attr = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
			el.setAttribute(attr, String(value));
		}
		svg.appendChild(el);
	}
	return svg;
};
