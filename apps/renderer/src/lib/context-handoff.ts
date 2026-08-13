import type { EnvironmentId, SessionId } from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";

import { useComposerBridge } from "../store/composer-bridge.ts";
import { dispatchSessionCommand } from "./session-timeline-client-bus.ts";

type ContextRef = { readonly relPath: string; readonly absPath: string };

export const saveContextText = async (input: {
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly text: string;
	readonly ext: string;
	readonly rootPath?: string;
}): Promise<ContextRef> =>
	(
		await dispatchSessionCommand<
			{
				readonly sessionId: SessionId;
				readonly text: string;
				readonly ext: string;
				readonly rootPath?: string;
			},
			ContextRef
		>({
			ref: {
				environmentId: input.environmentId,
				sessionId: input.sessionId,
			},
			kind: "context.saveText",
			commandId: CommandId.make(`context-save:${crypto.randomUUID()}`),
			payload: {
				sessionId: input.sessionId,
				text: input.text,
				ext: input.ext,
				...(input.rootPath === undefined ? {} : { rootPath: input.rootPath }),
			},
			retry: "never",
		})
	).result;

/** Write text into the session workspace's `.context/files/` as a `.md` file. */
export const saveContextFile = async (
	environmentId: EnvironmentId,
	sessionId: SessionId,
	text: string,
): Promise<ContextRef | null> => {
	try {
		const res = await saveContextText({
			environmentId,
			sessionId,
			text,
			ext: "md",
		});
		return { relPath: res.relPath, absPath: res.absPath };
	} catch {
		return null;
	}
};

/**
 * The latest `ExitPlanMode` plan text for any session (server-backed, cheap),
 * or `null` if that session never proposed a plan.
 */
export const fetchLatestPlan = async (
	environmentId: EnvironmentId,
	sessionId: SessionId,
): Promise<string | null> => {
	try {
		const { result: res } = await dispatchSessionCommand<
			{ readonly sessionId: SessionId },
			{ readonly plan: string | null }
		>({
			ref: { environmentId, sessionId },
			kind: "session.latestPlan",
			commandId: CommandId.make(`session-plan:${crypto.randomUUID()}`),
			payload: { sessionId },
			retry: "never",
		});
		return res.plan;
	} catch {
		return null;
	}
};

/** Serialise a source session's transcript to Markdown via the server. */
export const fetchTranscriptMarkdown = async (
	environmentId: EnvironmentId,
	sourceSessionId: SessionId,
): Promise<string | null> => {
	try {
		const { result: res } = await dispatchSessionCommand<
			{ readonly sessionId: SessionId },
			{ readonly markdown: string }
		>({
			ref: { environmentId, sessionId: sourceSessionId },
			kind: "session.exportTranscript",
			commandId: CommandId.make(`session-transcript:${crypto.randomUUID()}`),
			payload: { sessionId: sourceSessionId },
			retry: "never",
		});
		return res.markdown;
	} catch {
		return null;
	}
};

/** Drop a file chip into the CURRENTLY mounted composer (bridge-backed). */
export const attachToCurrentComposer = (ref: ContextRef): boolean => {
	const attach = useComposerBridge.getState().attachFile;
	if (attach === null) return false;
	attach({ relPath: ref.relPath, absPath: ref.absPath, kind: "file" });
	return true;
};

/**
 * Drop a file chip into a composer that may not be mounted yet — e.g. right
 * after creating a new chat, whose composer mounts on the next render and only
 * then binds the bridge. Polls the bridge briefly so the chip lands once the
 * new composer is ready.
 */
export const attachFileWhenReady = (
	ref: ContextRef,
	tries = 20,
	delayMs = 50,
): void => {
	if (attachToCurrentComposer(ref)) return;
	if (tries <= 0) return;
	setTimeout(() => attachFileWhenReady(ref, tries - 1, delayMs), delayMs);
};
