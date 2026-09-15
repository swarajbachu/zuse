import "@zuse/i18n/english/common";
import {
	EMPTY_COMPOSER_CONTEXTS,
	useComposerDraftsStore,
} from "../../store/composer-drafts.ts";
import { ContextPill } from "../context-pill.tsx";
import { MarkdownBody } from "../markdown-body.tsx";

/** Staged context is separate from the editor and only joins the user's next send. */
export function ComposerContextTray({ draftKey }: { draftKey: string }) {
	const items = useComposerDraftsStore(
		(s) => s.contextsByKey[draftKey] ?? EMPTY_COMPOSER_CONTEXTS,
	);
	if (!items.length) return null;
	return (
		<div className="flex flex-wrap gap-1.5 px-2 py-1.5">
			{items.map((item) => (
				<ContextPill
					key={item.id}
					label={item.label}
					onRemove={() =>
						useComposerDraftsStore
							.getState()
							.removeContexts(draftKey, [item.id])
					}
				>
					<MarkdownBody githubHtml>{item.text}</MarkdownBody>
				</ContextPill>
			))}
		</div>
	);
}
