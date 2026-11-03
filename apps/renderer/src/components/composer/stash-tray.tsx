import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ArchiveIcon, Cancel01Icon } from "@zuse/icons/stroke-rounded";

import { formatShortcut } from "~/lib/shortcuts";
import { useComposerDraftsStore } from "../../store/composer-drafts.ts";
import {
	TrayPill,
	trayPillActionClass,
	trayPillTextActionClass,
} from "./tray-pill.tsx";

/**
 * Above-composer row for the draft set aside with Ctrl+S. Shows the first
 * line so the user knows what is parked; restoring swaps it back in.
 */
export function StashTray({
	draftKey,
	onRestore,
}: {
	readonly draftKey: string;
	readonly onRestore: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const stash = useComposerDraftsStore((s) => s.stashesByKey[draftKey]);
	const swapStash = useComposerDraftsStore((s) => s.swapStash);
	if (stash === undefined) return null;
	const preview = stash.doc.trim().replace(/\s+/g, " ");
	const shortcut = formatShortcut("composer.stash");
	return (
		<TrayPill
			flush
			icon={<HugeiconsIcon icon={ArchiveIcon} className="size-3.5" />}
			title={uiMessage("chat:stash_tray_title")}
			subtitle={preview}
			onPillClick={onRestore}
			ariaLabel={uiMessage("chat:stash_tray_restore_draft")}
			actions={
				<>
					<button
						type="button"
						className={trayPillTextActionClass}
						onClick={onRestore}
						title={shortcut || undefined}
					>
						{uiMessage("chat:stash_tray_restore")}
					</button>
					<button
						type="button"
						className={trayPillActionClass}
						onClick={() => swapStash(draftKey, null)}
						aria-label={uiMessage("chat:stash_tray_discard")}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
					</button>
				</>
			}
		/>
	);
}
