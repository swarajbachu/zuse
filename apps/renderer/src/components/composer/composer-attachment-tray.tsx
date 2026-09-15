import type { FolderId, SessionId, WorktreeId } from "@zuse/contracts";
import { useAnnotationsStore } from "../../store/annotations.ts";
import { useComposerDraftsStore } from "../../store/composer-drafts.ts";
import { AnnotationTray } from "./annotation-tray.tsx";
import { ComposerContextTray } from "./composer-context-tray.tsx";

export function ComposerAttachmentTray({
	draftKey,
	sessionId,
	folderId,
	worktreeId,
}: {
	draftKey: string;
	sessionId: SessionId | null;
	folderId: FolderId | null;
	worktreeId: WorktreeId | null;
}) {
	const hasAnnotations = useAnnotationsStore(
		(s) => sessionId !== null && (s.bySession[sessionId]?.length ?? 0) > 0,
	);
	const hasContext = useComposerDraftsStore(
		(s) => (s.contextsByKey[draftKey]?.length ?? 0) > 0,
	);
	if (!hasAnnotations && !hasContext) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
			{sessionId !== null && (
				<AnnotationTray
					sessionId={sessionId}
					folderId={folderId}
					worktreeId={worktreeId}
				/>
			)}
			<ComposerContextTray draftKey={draftKey} />
		</div>
	);
}
