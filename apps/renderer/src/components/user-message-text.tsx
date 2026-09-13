import type { ReactNode } from "react";
import { openExternal } from "../lib/platform-capabilities";
import { hostnameFromLink } from "../lib/site-favicon";
import { knownSiteLink, siteLinksInText } from "../lib/site-link";
import { SiteFavicon } from "./site-favicon";

/** Preserve literal message text around the same links shown in the composer. */
export function UserMessageText({ text }: { text: string }) {
	const content: ReactNode[] = [];
	let cursor = 0;
	for (const { url, from, to } of siteLinksInText(text)) {
		const label = knownSiteLink(url)?.label ?? url;
		content.push(
			text.slice(cursor, from),
			<a
				key={from}
				className="compact-site-link"
				href={url}
				title={url}
				aria-label={`${label} (${hostnameFromLink(url)})`}
				onClick={(event) => {
					event.preventDefault();
					void openExternal(url);
				}}
			>
				<SiteFavicon url={url} className="site-link-favicon" />
				<span className="site-link-label">{label}</span>
			</a>,
		);
		cursor = to;
	}
	content.push(text.slice(cursor));
	return <div className="whitespace-pre-wrap break-words">{content}</div>;
}
