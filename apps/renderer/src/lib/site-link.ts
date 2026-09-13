import { hostnameFromLink } from "./site-favicon";

/** HTTP links and their original offsets, shared by drafts and sent messages. */
export function* siteLinksInText(text: string) {
	for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/giu)) {
		const url = match[0].replace(/[.,;:!?\])}]+$/u, "");
		if (hostnameFromLink(url) !== null) {
			yield { url, from: match.index, to: match.index + url.length };
		}
	}
}

export type KnownSite = "github" | "gitlab" | "linear" | "figma" | "notion";

/** Local URL formatting only: the original URL remains the navigation target. */
export const knownSiteLink = (
	value: string,
): { site: KnownSite; label: string } | null => {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.port !== "")
			return null;
		const host = url.hostname.toLowerCase().replace(/^www\./u, "");
		const parts = url.pathname
			.split("/")
			.filter(Boolean)
			.map(decodeURIComponent);
		if (host === "github.com") {
			const [owner, repo, kind, id] = parts;
			const repository = [owner, repo].filter(Boolean).join("/");
			const label =
				repo &&
				id &&
				["pull", "issues", "discussions"].includes(kind ?? "") &&
				/^\d+$/u.test(id)
					? `${repository}#${id}`
					: repo && kind === "commit" && id
						? `${repository}@${id.slice(0, 7)}`
						: parts.join("/") || "GitHub";
			return { site: "github", label };
		}
		if (host === "gitlab.com") {
			const separator = parts.indexOf("-");
			const kind = parts[separator + 1];
			const id = parts[separator + 2];
			const label =
				separator > 0 &&
				id &&
				/^\d+$/u.test(id) &&
				(kind === "merge_requests" || kind === "issues")
					? `${parts.slice(0, separator).join("/")}${kind === "merge_requests" ? "!" : "#"}${id}`
					: parts.join("/") || "GitLab";
			return { site: "gitlab", label };
		}
		if (host === "linear.app") {
			const issue = parts.indexOf("issue");
			return {
				site: "linear",
				label:
					(issue >= 0 ? parts[issue + 1] : null) || parts.at(-1) || "Linear",
			};
		}
		if (host === "figma.com") {
			return { site: "figma", label: parts[2]?.replace(/-/gu, " ") || "Figma" };
		}
		if (
			host === "notion.so" ||
			host === "notion.site" ||
			host.endsWith(".notion.site")
		) {
			const title = parts
				.at(-1)
				?.replace(/-?[a-f\d]{32}$/iu, "")
				.replace(/-/gu, " ");
			return { site: "notion", label: title || "Notion" };
		}
		return null;
	} catch {
		return null;
	}
};
