import { source } from "@/lib/source";

const documentationRoutes = new Set(source.getPages().map((page) => page.url));

function makeDocumentationLinksMachineReadable(markdown: string) {
	return markdown.replace(
		/\]\((\/[^)#]+)(#[^)]+)?\)/gu,
		(match, path: string, hash: string | undefined) => {
			const normalizedPath = path.replace(/\/$/u, "") || "/";
			if (!documentationRoutes.has(normalizedPath)) return match;
			return `](${normalizedPath}.md${hash ?? ""})`;
		},
	);
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
	const markdown = makeDocumentationLinksMachineReadable(
		await page.data.getText("processed"),
	);

	return `# ${page.data.title}

> ${page.data.description}

Canonical URL: https://docs.zuse.sh${page.url}

${markdown}`;
}
