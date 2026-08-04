"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import type { FullSearchTriggerProps } from "fumadocs-ui/layouts/shared/slots/search-trigger";
import { Search } from "lucide-react";

export function CleanSearchTrigger({
	className,
	hideIfDisabled,
	...props
}: FullSearchTriggerProps) {
	const { enabled, hotKey, setOpenSearch } = useSearchContext();
	if (hideIfDisabled && !enabled) return null;

	return (
		<button
			type="button"
			data-search-full=""
			aria-label="Search documentation"
			aria-keyshortcuts="Meta+K Control+K"
			className={["clean-search-trigger", className].filter(Boolean).join(" ")}
			{...props}
			onClick={() => setOpenSearch(true)}
		>
			<Search aria-hidden="true" />
			<span>Search docs</span>
			<kbd>{hotKey.map((key) => key.display)}</kbd>
		</button>
	);
}
