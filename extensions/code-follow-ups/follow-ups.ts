import type { ExtensionAttachmentSnapshot } from "@zuse/extension-sdk";
export function scanFollowUps(
	text: string,
	path: string,
): ExtensionAttachmentSnapshot[] {
	if (
		/(?:\.min\.[cm]?js|\.map|(?:package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml))$/.test(
			path,
		)
	)
		return [];
	const lines = text.split(/\r?\n/);
	const results: ExtensionAttachmentSnapshot[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const match = line.match(
			/(?:\/\/|\/\*|^\s*\*|^\s*#|<!--|--\s)\s*(TODO|FIXME)\b(?:\([^)]*\))?\s*:?\s*(.*)/,
		);
		if (!match) continue;
		const start = Math.max(0, i - 2);
		const end = Math.min(lines.length, i + 4);
		results.push({
			id: `${path}:${i + 1}`,
			metadata: { tag: match[1] ?? "TODO", file: path },
			title: `${match[1]}: ${match[2] || "Follow up"}`,
			subtitle: `${path}:${i + 1}`,
			text: `Source: ${path}:${i + 1}\n\n${lines
				.slice(start, end)
				.map((value, offset) => `${start + offset + 1}: ${value}`)
				.join("\n")}`,
		});
	}
	return results;
}
