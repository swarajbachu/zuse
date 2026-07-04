import type { SessionId } from "@zuse/wire";
import { create } from "zustand";

type RectSnapshot = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type ChatSendMotion = {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly text: string;
  readonly sourceRect: RectSnapshot;
  readonly createdAt: number;
};

type ChatMotionState = {
  readonly pendingBySession: Record<string, ChatSendMotion>;
  readonly startSend: (
    sessionId: SessionId,
    input: {
      readonly text: string;
      readonly sourceRect: RectSnapshot;
    },
  ) => void;
  readonly consumeSend: (sessionId: SessionId, id: string) => void;
};

export const useChatMotionStore = create<ChatMotionState>((set) => ({
  pendingBySession: {},
  startSend: (sessionId, input) =>
    set((s) => ({
      pendingBySession: {
        ...s.pendingBySession,
        [sessionId as string]: {
          id: crypto.randomUUID(),
          sessionId,
          text: input.text,
          sourceRect: input.sourceRect,
          createdAt: Date.now(),
        },
      },
    })),
  consumeSend: (sessionId, id) =>
    set((s) => {
      const key = sessionId as string;
      if (s.pendingBySession[key]?.id !== id) return s;
      const { [key]: _consumed, ...pendingBySession } = s.pendingBySession;
      return { pendingBySession };
    }),
}));
