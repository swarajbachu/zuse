import { useState } from "react";

import { faviconUrlForLink, hostnameFromLink } from "~/lib/site-favicon";
import { cn } from "~/lib/utils";

export function SiteFavicon({
	url,
	className,
}: {
	readonly url: string;
	readonly className?: string;
}) {
	const src = faviconUrlForLink(url);
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const showImage = src !== null && failedSrc !== src;

	if (!showImage) {
		return (
			<svg
				aria-hidden
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className={cn("shrink-0", className)}
			>
				<circle cx="12" cy="12" r="9" />
				<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
			</svg>
		);
	}

	return (
		<img
			src={src}
			alt=""
			aria-hidden
			className={cn("shrink-0 rounded-[2px] object-contain", className)}
			onError={() => setFailedSrc(src)}
			title={hostnameFromLink(url) ?? undefined}
		/>
	);
}
