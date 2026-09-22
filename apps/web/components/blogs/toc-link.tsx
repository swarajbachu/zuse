"use client";

import { useActiveAnchor } from "fumadocs-core/toc";
import type { ReactNode } from "react";

export function TocLink({
	url,
	children,
}: {
	url: string;
	children: ReactNode;
}) {
	const active = useActiveAnchor() === url.slice(1);
	return (
		<a
			href={url}
			aria-current={active ? "location" : undefined}
			className="article-toc-link"
		>
			{children}
		</a>
	);
}
