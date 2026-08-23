export type ContentRepresentation = "html" | "markdown" | "unsupported";

type MediaRange = {
	type: string;
	subtype: string;
	quality: number;
	index: number;
};

type Match = {
	quality: number;
	specificity: number;
	index: number;
};

const parseAccept = (accept: string): MediaRange[] =>
	accept
		.split(",")
		.map((part, index) => {
			const [mediaType = "", ...parameters] = part
				.trim()
				.toLowerCase()
				.split(";");
			const [type = "", subtype = ""] = mediaType.trim().split("/");
			const qualityParameter = parameters
				.map((parameter) => parameter.trim())
				.find((parameter) => parameter.startsWith("q="));
			const parsedQuality = qualityParameter
				? Number.parseFloat(qualityParameter.slice(2))
				: 1;

			return {
				type,
				subtype,
				quality:
					Number.isFinite(parsedQuality) &&
					parsedQuality >= 0 &&
					parsedQuality <= 1
						? parsedQuality
						: 0,
				index,
			};
		})
		.filter((range) => range.type && range.subtype);

const bestMatch = (
	ranges: MediaRange[],
	type: string,
	subtype: string,
): Match | undefined => {
	let best: Match | undefined;

	for (const range of ranges) {
		if (range.type !== "*" && range.type !== type) continue;
		if (range.subtype !== "*" && range.subtype !== subtype) continue;

		const specificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
		const candidate = {
			quality: range.quality,
			specificity,
			index: range.index,
		};

		if (
			!best ||
			candidate.specificity > best.specificity ||
			(candidate.specificity === best.specificity &&
				candidate.quality > best.quality) ||
			(candidate.specificity === best.specificity &&
				candidate.quality === best.quality &&
				candidate.index < best.index)
		) {
			best = candidate;
		}
	}

	return best;
};

export const negotiateContent = (
	acceptHeader: string | null,
): ContentRepresentation => {
	if (!acceptHeader?.trim()) return "html";

	const ranges = parseAccept(acceptHeader);
	const htmlMatch = bestMatch(ranges, "text", "html");
	const markdownMatch = bestMatch(ranges, "text", "markdown");
	const html = htmlMatch?.quality === 0 ? undefined : htmlMatch;
	const markdown = markdownMatch?.quality === 0 ? undefined : markdownMatch;

	if (!html && !markdown) return "unsupported";
	if (!markdown) return "html";
	if (!html) return "markdown";

	if (markdown.quality !== html.quality) {
		return markdown.quality > html.quality ? "markdown" : "html";
	}
	if (markdown.specificity !== html.specificity) {
		return markdown.specificity > html.specificity ? "markdown" : "html";
	}

	// Wildcards match both representations equally, so keep the web default.
	return markdown.index < html.index && markdown.specificity > 0
		? "markdown"
		: "html";
};

export const appendVary = (
	currentValue: string | null,
	value: string,
): string => {
	const values = new Map<string, string>();
	for (const item of [...(currentValue?.split(",") ?? []), value]) {
		const trimmed = item.trim();
		if (trimmed && !values.has(trimmed.toLowerCase())) {
			values.set(trimmed.toLowerCase(), trimmed);
		}
	}
	return [...values.values()].join(", ");
};
