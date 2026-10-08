import { viewWorkspaceImage } from "@zuse/agents/drivers/image-mcp-tools";

/** Embed only canonical workspace images. The image tool owns path/MIME/size policy. */
export async function embedHtmlImages(
	html: string,
	cwd: string,
	signal: AbortSignal,
): Promise<string> {
	const paths = new Set<string>();
	const pattern =
		/["'`(]((?:\/|[A-Za-z]:[\\/])[^"'`()\r\n<>]+\.(?:png|jpe?g|gif|webp))["'`)]/gi;
	for (const match of html.matchAll(pattern)) if (match[1]) paths.add(match[1]);
	if (paths.size > 32)
		throw new Error("A visual can embed at most 32 workspace images");
	const maxDocumentBytes = 4 * 1024 * 1024;
	for (const path of paths) {
		signal.throwIfAborted();
		const result = await viewWorkspaceImage({ cwd }, path);
		const image = result.content.find((item) => item.type === "image");
		if (image?.type !== "image") throw new Error(`Could not embed ${path}`);
		const url = `data:${image.mimeType};base64,${image.data}`;
		const copies = [...html.matchAll(pattern)].filter(
			(match) => match[1] === path,
		).length;
		// Count every occurrence before allocating the expanded string. The
		// document must also fit the authenticated cloud attachment-read response.
		if (
			Buffer.byteLength(html) +
				copies * (Buffer.byteLength(url) - Buffer.byteLength(path)) >
			maxDocumentBytes
		)
			throw new Error("HTML with embedded images exceeds 4 MB");
		html = html.replace(pattern, (match, found: string) =>
			found === path ? match.replace(found, url) : match,
		);
	}
	return html;
}
