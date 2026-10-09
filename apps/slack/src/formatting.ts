const escapeText = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Convert agent Markdown to Slack mrkdwn without rewriting code. */
export const markdownToSlack = (markdown: string): string => {
	const protectedParts: string[] = [];
	const protect = (text: string): string => {
		protectedParts.push(text);
		return `\u0000${protectedParts.length - 1}\u0000`;
	};
	let text = markdown.replaceAll("\u0000", "");
	text = text.replace(
		/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm,
		(_match, _fence: string, code: string) =>
			protect(`\`\`\`\n${escapeText(code)}\`\`\``),
	);
	text = text.replace(
		/(`+)([^\n]*?)\1/g,
		(_match, _ticks: string, code: string) =>
			protect(`\`${escapeText(code)}\``),
	);
	text = escapeText(text);
	text = text
		.replace(/^[ \t]{0,3}#{1,6}\s+(.+?)(?:\s+#+)?[ \t]*$/gm, "**$1**")
		.replace(/^([ \t]*)[-*+]\s+/gm, "$1• ")
		.replace(/\*\*([^\n]+?)\*\*/g, (_match, value: string) =>
			protect(`*${value}*`),
		)
		.replace(/__([^\n]+?)__/g, (_match, value: string) => protect(`*${value}*`))
		.replace(/\*([^*\n]+?)\*/g, "_$1_")
		.replace(/~~([^\n]+?)~~/g, "~$1~")
		.replace(/^&gt; ?/gm, "> ");
	text = text.replace(
		/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
		(_match, label: string, url: string) =>
			protect(
				`<${url.replaceAll("|", "%7C")}|${label.replaceAll("|", "&#124;")}>`,
			),
	);
	// Links and emphasis can contain protected inline code; restore inside out.
	for (let index = protectedParts.length - 1; index >= 0; index--)
		text = text.replaceAll(`\u0000${index}\u0000`, protectedParts[index] ?? "");
	return text;
};
