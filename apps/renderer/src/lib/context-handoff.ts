import { Effect } from "effect";

import type { SessionId } from "@zuse/wire";

import { useComposerBridge } from "../store/composer-bridge.ts";
import { useMessagesStore } from "../store/messages.ts";
import { getRpcClient } from "./rpc-client.ts";

type ContextRef = { readonly relPath: string; readonly absPath: string };

/**
 * Pull the most recent `ExitPlanMode` plan text out of a session's message
 * log, if any. Used by the plan-handoff button and the "Attach plan" action.
 */
export const latestPlanText = (sessionId: SessionId): string | null => {
  const messages = useMessagesStore.getState().messagesBySession[sessionId];
  if (messages === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]!.content;
    if (c._tag === "tool_use" && c.tool === "ExitPlanMode") {
      const input = c.input;
      if (
        typeof input === "object" &&
        input !== null &&
        "plan" in input &&
        typeof (input as { plan?: unknown }).plan === "string"
      ) {
        return (input as { plan: string }).plan;
      }
    }
  }
  return null;
};

/** Write text into the session workspace's `.context/files/` as a `.md` file. */
export const saveContextFile = async (
  sessionId: SessionId,
  text: string,
): Promise<ContextRef | null> => {
  try {
    const client = await getRpcClient();
    const res = await Effect.runPromise(
      client.context.saveText({ sessionId, text, ext: "md" }),
    );
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
  sessionId: SessionId,
): Promise<string | null> => {
  try {
    const client = await getRpcClient();
    const res = await Effect.runPromise(
      client.session.latestPlan({ sessionId }),
    );
    return res.plan;
  } catch {
    return null;
  }
};

/** Serialise a source session's transcript to Markdown via the server. */
export const fetchTranscriptMarkdown = async (
  sourceSessionId: SessionId,
): Promise<string | null> => {
  try {
    const client = await getRpcClient();
    const res = await Effect.runPromise(
      client.session.exportTranscript({ sessionId: sourceSessionId }),
    );
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
