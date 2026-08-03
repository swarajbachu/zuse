import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function DocumentationLayout({
	children,
}: {
	children: ReactNode;
}) {
	return (
		<DocsLayout
			tree={source.pageTree}
			{...baseOptions()}
			sidebar={{ collapsible: true }}
		>
			{children}
		</DocsLayout>
	);
}
