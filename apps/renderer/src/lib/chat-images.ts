import type { Message } from "@zuse/contracts";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { normalizeToolCallEnvelope } from "./tool-call-envelope";
import { toolImageDataUrl, toolImageResult } from "./tool-image-result";

export interface ChatImage {
	readonly src: string;
	readonly alt: string;
}
const parser = unified().use(remarkParse);
const cache = new WeakMap<Message, readonly ChatImage[]>();

export function markdownImages(text: string): ChatImage[] {
	const root = parser.parse(text);
	const definitions = new Map<string, string>();
	const images: ChatImage[] = [];
	type Node = {
		type: string;
		url?: string;
		alt?: string | null;
		identifier?: string;
		children?: Node[];
	};
	const visit = (node: Node, fn: (node: Node) => void) => {
		fn(node);
		node.children?.forEach((child) => {
			visit(child, fn);
		});
	};
	visit(root, (node) => {
		if (node.type === "definition" && node.identifier && node.url)
			definitions.set(node.identifier, node.url);
	});
	visit(root, (node) => {
		const src =
			node.type === "image"
				? node.url
				: node.type === "imageReference"
					? definitions.get(node.identifier ?? "")
					: undefined;
		if (src && !/^(?!https?:|file:)[a-z][a-z0-9+.-]*:/i.test(src))
			images.push({ src, alt: node.alt ?? "" });
	});
	return images;
}

/** Read the transcript, including rows currently outside the virtual viewport. */
export function collectChatImages(messages: readonly Message[]): ChatImage[] {
	const images: ChatImage[] = [];
	for (const message of messages) {
		let found = cache.get(message);
		if (!found) {
			const content = message.content;
			found = content._tag === "assistant" ? markdownImages(content.text) : [];
			if (content._tag === "tool_result" && !content.isError) {
				const result = normalizeToolCallEnvelope(
					"",
					{},
					{ output: content.output, isError: false },
				).result;
				const image = toolImageResult(result?.output);
				if (image)
					found = [{ src: toolImageDataUrl(image), alt: "Generated image" }];
			}
			cache.set(message, found);
		}
		images.push(...found);
	}
	const seen = new Set<string>();
	return images.filter((image) => {
		if (seen.has(image.src)) return false;
		seen.add(image.src);
		return true;
	});
}
