import type { CodeAnnotation } from "@zuse/contracts";
import { useCallback } from "react";

import { useAnnotationsStore } from "../../store/annotations.ts";
import { useSessionsStore } from "../../store/sessions.ts";
export interface AnnotationDraft {
	readonly relPath: string;
	readonly absPath: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly comment: string;
	readonly diffSide?: "additions" | "deletions";
	readonly oldPath?: string;
	readonly baseRef?: string;
}

/**
 * Returns a stable callback that drops a finished annotation into the focused
 * chat's draft list. The file editor and diff view live in a different pane
 * from the composer, so the target session is resolved from
 * `selectedSessionId` at confirm time. Returns the stored annotation, or
 * `null` when there is no active chat to attach to.
 */
export const useAddAnnotation = (): ((
	draft: AnnotationDraft,
) => CodeAnnotation | null) =>
	useCallback((draft: AnnotationDraft): CodeAnnotation | null => {
		const sessionId = useSessionsStore.getState().selectedSessionId;
		if (sessionId === null) return null;
		const id = useAnnotationsStore.getState().add(sessionId, draft);
		return { ...draft, id };
	}, []);
