import "@zuse/i18n/english/chat";
import type { EditorView } from "@codemirror/view";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Bookmark01Icon, Cancel01Icon } from "@zuse/icons/stroke-rounded";
import { useState } from "react";

import { formatShortcut } from "~/lib/shortcuts";
import { formatTimeAgo, useRelativeTimeTick } from "~/lib/use-relative-time";
import { cn } from "~/lib/utils";
import {
	type StashedPrompt,
	usePromptStash,
} from "../../store/prompt-stash.ts";
import { ComposerListPopover } from "./composer-list-popover.tsx";
import { trayPillActionClass } from "./tray-pill.tsx";

/**
 * Prompts set aside with Ctrl+S, in the same popover as the other composer
 * lists. Enter restores, Cmd/Ctrl+Backspace deletes, Escape closes.
 */
export function StashPopover({
	view,
	onRestore,
	onClose,
}: {
	readonly view: EditorView;
	readonly onRestore: (entry: StashedPrompt) => void;
	readonly onClose: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const entries = usePromptStash((s) => s.entries);
	const remove = usePromptStash((s) => s.remove);
	const now = useRelativeTimeTick();
	const [active, setActive] = useState(0);
	const activeEntry = entries[Math.min(active, entries.length - 1)];

	return (
		<ComposerListPopover
			view={view}
			label={uiMessage("chat:stash_list")}
			header={
				<>
					<HugeiconsIcon icon={Bookmark01Icon} className="size-3.5" />
					<span className="flex-1">{uiMessage("chat:stash_title")}</span>
					<span className="tabular-nums">{entries.length}</span>
				</>
			}
			items={entries.map((entry) => ({
				id: entry.id,
				content: entry.doc.trim().replace(/\s+/g, " "),
				trailing: (
					<>
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums group-hover:hidden">
							{formatTimeAgo(entry.createdAt, now)}
						</span>
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								remove(entry.id);
							}}
							aria-label={uiMessage("chat:stash_delete")}
							className={cn(
								trayPillActionClass,
								"hidden size-5 group-hover:flex",
							)}
						>
							<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
						</button>
					</>
				),
			}))}
			active={active}
			onActiveChange={setActive}
			onPick={(index) => {
				const entry = entries[index];
				if (entry !== undefined) onRestore(entry);
			}}
			onClose={onClose}
			onKey={(event) => {
				if (
					event.key !== "Backspace" ||
					!(event.metaKey || event.ctrlKey) ||
					activeEntry === undefined
				)
					return false;
				remove(activeEntry.id);
				return true;
			}}
			empty={uiMessage("chat:stash_empty", {
				shortcut: formatShortcut("composer.stash"),
			})}
		/>
	);
}
