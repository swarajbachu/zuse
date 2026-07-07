import type { SessionStatus } from "@zuse/wire";

export const isInterruptVisible = (status: SessionStatus | undefined): boolean =>
  status === "running" || status === "booting";

export const isFreshChat = (messages: readonly { role?: string; content?: { _tag?: string } }[]): boolean =>
  !messages.some(
    (message) =>
      message.role === "user" ||
      message.content?._tag === "user" ||
      message.content?._tag === "user_rich",
  );
