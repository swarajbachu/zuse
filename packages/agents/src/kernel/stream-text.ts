/**
 * Append provider stream deltas. Exact mode preserves token boundaries;
 * sentence-start mode retains the legacy ACP convention for sentence chunks.
 */
export const appendStreamText = (
	buffer: string,
	text: string,
	boundary: "exact" | "sentence-start" = "exact",
): string => {
	if (
		boundary === "sentence-start" &&
		buffer.length > 0 &&
		text.length > 0 &&
		/[A-Za-z0-9]$/.test(buffer) &&
		/^[A-Z][a-z]/.test(text)
	) {
		return `${buffer} ${text}`;
	}
	return `${buffer}${text}`;
};
