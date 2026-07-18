import type { DiffLine } from "@zuse/client-runtime/timeline";
import { Text, View } from "react-native";
import { useUniwind } from "uniwind";

import { DARK_SYNTAX, LIGHT_SYNTAX } from "~/lib/syntax-highlighting";
import { DiffCodeRow } from "./review-diff-list";

const keyedLines = (lines: readonly DiffLine[], limit: number) => {
	const occurrences = new Map<string, number>();
	return lines.slice(0, limit).map((line) => {
		const signature = `${line.kind}:${line.oldLine}:${line.newLine}:${line.text}`;
		const occurrence = occurrences.get(signature) ?? 0;
		occurrences.set(signature, occurrence + 1);
		return { key: `${signature}:${occurrence}`, line };
	});
};

export function InlineFileDiff({
	lines,
	lineLimit = 160,
}: {
	lines: readonly DiffLine[];
	lineLimit?: number;
}) {
	const { theme } = useUniwind();
	const palette = theme === "dark" ? DARK_SYNTAX : LIGHT_SYNTAX;

	if (lines.length === 0) {
		return (
			<Text className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
				Change preview unavailable.
			</Text>
		);
	}

	return (
		<View>
			{keyedLines(lines, lineLimit).map(({ key, line }) => (
				<DiffCodeRow key={key} line={line} palette={palette} />
			))}
			{lines.length > lineLimit ? (
				<Text className="border-t border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
					Preview limited to {lineLimit} lines.
				</Text>
			) : null}
		</View>
	);
}
