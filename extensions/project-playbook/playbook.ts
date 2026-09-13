import type { ExtensionAttachmentSnapshot } from "@zuse/extension-sdk";
export function parsePlaybook(
	markdown: string,
	path: string,
): ExtensionAttachmentSnapshot[] {
	const lines = markdown.split(/\r?\n/);
	const sections: { title: string; start: number; lines: string[] }[] = [];
	let current = { title: path, start: 1, lines: [] as string[] };
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const marker = line.match(/^\s*(`{3,}|~{3,})/);
		if (marker) {
			if (!fence) fence = marker[1]?.[0] ?? null;
			else if (marker[1]?.[0] === fence) fence = null;
		}
		const heading = !fence ? line.match(/^#{1,6}\s+(.+?)\s*#*$/) : null;
		if (heading) {
			if (current.lines.join("\n").trim()) sections.push(current);
			current = { title: heading[1] ?? path, start: i + 1, lines: [] };
		}
		current.lines.push(line);
	}
	if (current.lines.join("\n").trim()) sections.push(current);
	return sections.map((section) => ({
		id: `${path}:${section.start}`,
		title: section.title,
		subtitle: `${path}:${section.start}`,
		text: `Source: ${path}:${section.start}\n\n${section.lines.join("\n")}`,
	}));
}
