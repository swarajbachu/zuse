import type { ReactNode } from "react";

export function ChangelogText({ text }: { text: string }) {
	const content: ReactNode[] = [];
	let offset = 0;

	for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
		content.push(text.slice(offset, match.index));
		content.push(
			<a
				key={match.index}
				href={match[2]}
				className="underline underline-offset-4 hover:text-primary"
			>
				{match[1]}
			</a>,
		);
		offset = match.index + match[0].length;
	}

	content.push(text.slice(offset));
	return <span>{content}</span>;
}
