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
import { APIPage } from "@/components/api-page";
import {
	type PageLink,
	Prerequisites,
	RelatedPages,
} from "@/components/mdx-components";
import {
	type DocsCrumb,
	DocsStructuredData,
} from "@/components/structured-data";
import { GITHUB_URL } from "@/lib/layout.shared";
import { docsSocialMetadata } from "@/lib/seo";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

type PageProps = {
	params: Promise<{ slug?: string[] }>;
};

type DocumentationPage = (typeof source)["$inferPage"];
type ArticlePage = Extract<DocumentationPage, { type: "docs" }>;
type EndpointPage = Extract<DocumentationPage, { type: "openapi" }>;

export const dynamicParams = false;

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
		...docsSocialMetadata({
			title: titleOf(page),
			description: page.data.description,
			path: page.url,
		}),
	};
}

export default async function Page({ params }: PageProps) {
	const page = source.getPage((await params).slug);
	if (!page) notFound();

	return (
		<main className="contents">
			<DocsStructuredData
				title={titleOf(page)}
				description={page.data.description}
				path={page.url}
				crumbs={breadcrumbs(page)}
			/>
			{page.type === "openapi" ? (
				<Endpoint page={page} />
			) : (
				<Article page={page} />
			)}
		</main>
	);
}

/** Generated API pages can lack a title; fall back to the section name. */
const titleOf = (page: DocumentationPage) => page.data.title ?? "API reference";

/** Docs home, then each ancestor page that exists, then the page itself. */
function breadcrumbs(page: DocumentationPage): DocsCrumb[] {
	const crumbs: DocsCrumb[] = [{ name: "Zuse Docs", path: "/start" }];
	const slugs = page.slugs;
	for (let depth = 1; depth <= slugs.length; depth++) {
		const node = source.getPage(slugs.slice(0, depth));
		if (node && !crumbs.some((crumb) => crumb.path === node.url))
			crumbs.push({ name: titleOf(node), path: node.url });
	}
	return crumbs;
}

function Endpoint({ page }: { page: EndpointPage }) {
	return (
		<DocsPage full breadcrumb={{ enabled: false }}>
			<header className="docs-header">
				<DocsTitle>{page.data.title}</DocsTitle>
			</header>
			<DocsBody className="api-reference-body">
				<APIPage {...page.data.getOpenAPIPageProps()} />
			</DocsBody>
		</DocsPage>
	);
}

function toPageLink(href: string): PageLink {
	const target = source.getPage(href.split("/").filter(Boolean));
	const title =
		target?.type === "docs"
			? (target.data.navTitle ?? target.data.title)
			: target?.data.title;
	return { href, title: title ?? href };
}

function Article({ page }: { page: ArticlePage }) {
	const Body = page.data.body;
	const markdownUrl = `${page.url}.md`;
	const githubUrl = `${GITHUB_URL}/blob/main/apps/docs/content/docs/${page.data.info.path}`;
	const related = Array.from(
		new Set([
			...page.data.related,
			...source
				.getPages()
				.filter(
					(candidate): candidate is ArticlePage =>
						candidate.type === "docs" &&
						candidate.url !== page.url &&
						(candidate.data.related.includes(page.url) ||
							candidate.data.prerequisites.includes(page.url)),
				)
				.map((candidate) => candidate.url),
		]),
	)
		.slice(0, 6)
		.map(toPageLink);

	const pageActions = (
		<div className="page-actions">
			<MarkdownCopyButton markdownUrl={markdownUrl} />
			<ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
		</div>
	);

	return (
		<DocsPage
			toc={page.data.toc}
			full={page.data.full}
			breadcrumb={{ enabled: false }}
			tableOfContent={{ style: "clerk", footer: pageActions }}
			tableOfContentPopover={{ style: "clerk", footer: pageActions }}
		>
			<header className="docs-header">
				<DocsTitle>{page.data.title}</DocsTitle>
				<DocsDescription className="docs-description">
					{page.data.description}
				</DocsDescription>
			</header>

			<DocsBody>
				<Prerequisites links={page.data.prerequisites.map(toPageLink)} />
				<Body components={getMDXComponents()} />
				<RelatedPages links={related} />
			</DocsBody>
		</DocsPage>
	);
}
