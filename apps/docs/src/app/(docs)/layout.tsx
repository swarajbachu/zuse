import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { SearchTrigger } from "fumadocs-ui/layouts/shared/slots/search-trigger";
import type { ReactNode } from "react";
import { CleanSearchTrigger } from "@/components/clean-search-trigger";
import { baseOptions } from "@/lib/layout.shared";
import { documentationTree } from "@/lib/source";

export default async function DocumentationLayout({
	children,
}: {
	children: ReactNode;
}) {
	const options = await baseOptions();

	return (
		<DocsLayout
			tree={documentationTree}
			{...options}
			tabMode="auto"
			tabs={{ transform: (option) => ({ ...option, icon: undefined }) }}
			sidebar={{ collapsible: true }}
			slots={{
				searchTrigger: {
					sm: SearchTrigger,
					full: CleanSearchTrigger,
				},
			}}
		>
			{children}
		</DocsLayout>
	);
}
