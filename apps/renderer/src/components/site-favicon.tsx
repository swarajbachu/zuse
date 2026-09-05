import { useEffect, useRef } from "react";

import { mountSiteFavicon } from "~/lib/site-favicon-dom";
import { cn } from "~/lib/utils";

export function SiteFavicon({
	url,
	className,
}: {
	readonly url: string;
	readonly className?: string;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (ref.current !== null) return mountSiteFavicon(ref.current, url);
	}, [url]);
	return (
		<span
			ref={ref}
			aria-hidden="true"
			className={cn("site-favicon shrink-0", className)}
		/>
	);
}
