import "@zuse/i18n/english/common";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages } from "@zuse/i18n/react";
import { Cancel01Icon, File01Icon } from "@zuse/icons/stroke-rounded";
import {
	EMPTY_COMPOSER_CONTEXTS,
	useComposerDraftsStore,
} from "../../store/composer-drafts.ts";

/** Staged context is separate from the editor and only joins the user's next send. */
export function ComposerContextTray({ draftKey }: { draftKey: string }) {
	const { message } = useMessages(["common"]);
	const items = useComposerDraftsStore(
		(s) => s.contextsByKey[draftKey] ?? EMPTY_COMPOSER_CONTEXTS,
	);
	if (!items.length) return null;
	return (
		<div className="px-2 py-1">
			{items.map((item) => (
				<div key={item.id} className="flex items-start gap-1">
					<details className="min-w-0 flex-1">
						<summary className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/50">
							<HugeiconsIcon
								icon={File01Icon}
								className="size-[15px] shrink-0"
							/>
							<span className="truncate">{item.label}</span>
						</summary>
						<div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-2 py-1 text-xs text-muted-foreground">
							{item.text}
						</div>
					</details>
					<button
						type="button"
						className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
						aria-label={`${message("common:remove")} ${item.label}`}
						onClick={() =>
							useComposerDraftsStore
								.getState()
								.removeContexts(draftKey, [item.id])
						}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
					</button>
				</div>
			))}
		</div>
	);
}
