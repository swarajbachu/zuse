import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
	MarkdownCopyButton,
	ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Prerequisites, RelatedPages } from "@/components/mdx-components";
import { GITHUB_URL } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

type PageProps = {
	params: Promise<{ slug?: string[] }>;
};

export function generateStaticParams() {
	return source.generateParams();
}

export async function generateMetadata({
	params,
}: PageProps): Promise<Metadata> {
	const page = source.getPage((await params).slug);
	if (!page) notFound();

	return {
		title: page.data.title,
		description: page.data.description,
		alternates: { canonical: page.url },
	};
}

export default async function DocumentationPage({ params }: PageProps) {
	const page = source.getPage((await params).slug);
	if (!page) notFound();

	const Body = page.data.body;
	const markdownUrl = `${page.url}.md`;
	const githubUrl = `${GITHUB_URL}/blob/main/apps/docs/content/docs/${page.data.info.path}`;
	const related = Array.from(
		new Set([
			...page.data.related,
			...source
				.getPages()
				.filter(
					(candidate) =>
						candidate.url !== page.url &&
						(candidate.data.related.includes(page.url) ||
							candidate.data.prerequisites.includes(page.url)),
				)
				.map((candidate) => candidate.url),
		]),
	).slice(0, 6);

	return (
		<main className="contents">
			<DocsPage
				toc={page.data.toc}
				full={page.data.full}
				tableOfContent={{
					style: "clerk",
					footer: (
						<div className="mt-auto border-t pt-4 text-xs text-fd-muted-foreground">
							Verified against <strong>{page.data.lastVerified}</strong>
						</div>
					),
				}}
				tableOfContentPopover={{ style: "clerk" }}
			>
				<DocsTitle>{page.data.title}</DocsTitle>
				<DocsDescription>{page.data.description}</DocsDescription>

				<div className="page-action-row">
					<MarkdownCopyButton markdownUrl={markdownUrl} />
					<ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
					<div className="page-badges">
						{page.data.platforms.map((platform) => (
							<span key={platform}>{platform}</span>
						))}
						{page.data.providers.map((provider) => (
							<span key={provider}>{provider}</span>
						))}
					</div>
				</div>

				<DocsBody>
					<Prerequisites links={page.data.prerequisites} />
					<Body components={getMDXComponents()} />
					<RelatedPages links={related} />
				</DocsBody>
			</DocsPage>
		</main>
	);
}
