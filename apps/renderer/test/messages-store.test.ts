import { beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { ComposerInput, QueuedMessage, type SessionId } from "@memoize/wire";

const {
  setMessagesRpcClientForTest,
  useMessagesStore,
} = await import("../src/store/messages.ts");

const sessionId = "session-queue" as SessionId;
const input = new ComposerInput({
  text: "queued",
  attachments: [],
  fileRefs: [],
  skillRefs: [],
});

const queued = QueuedMessage.make({
  id: "q_1",
  sessionId,
  input,
  position: 0,
  createdAt: new Date("2026-06-21T00:00:00.000Z"),
  updatedAt: new Date("2026-06-21T00:00:00.000Z"),
});

let interruptCalls = 0;
let sendNowCalls: Array<{ readonly sessionId: SessionId; readonly queueId: string }> = [];
let resumeCalls: Array<{ readonly sessionId: SessionId }> = [];
let flushCalls: Array<{ readonly sessionId: SessionId }> = [];

setMessagesRpcClientForTest(
  async () =>
    ({
      messages: {
        interrupt: () =>
          Effect.sync(() => {
            interruptCalls += 1;
          }),
        "queue.sendNow": (payload: {
          readonly sessionId: SessionId;
          readonly queueId: string;
        }) =>
          Effect.sync(() => {
            sendNowCalls.push(payload);
          }),
        "queue.resume": (payload: { readonly sessionId: SessionId }) =>
          Effect.sync(() => {
            resumeCalls.push(payload);
          }),
        "queue.flush": (payload: { readonly sessionId: SessionId }) =>
          Effect.sync(() => {
            flushCalls.push(payload);
          }),
      },
    }) as Awaited<
      ReturnType<typeof import("../src/lib/rpc-client.ts").getRpcClient>
    >,
);

describe("messages store queue actions", () => {
  beforeEach(() => {
    interruptCalls = 0;
    sendNowCalls = [];
    resumeCalls = [];
    flushCalls = [];
    useMessagesStore.setState({
      messagesBySession: {},
      errorBySession: {},
      runningBySession: {},
      queueBySession: { [sessionId]: [queued] },
      queuePausedBySession: {},
      goalBySession: {},
    });
  });

  it("sends an idle queued item without interrupting", async () => {
    await useMessagesStore.getState().steerFromQueue(sessionId, queued.id);

    expect(interruptCalls).toBe(0);
    expect(sendNowCalls).toEqual([{ sessionId, queueId: queued.id }]);
  });

  it("resumes a paused queue through the resume RPC", async () => {
    useMessagesStore.setState({
      queuePausedBySession: { [sessionId]: true },
    });

    await useMessagesStore.getState().resumeQueue(sessionId);

    expect(resumeCalls).toEqual([{ sessionId }]);
    expect(useMessagesStore.getState().queuePausedBySession[sessionId]).toBe(
      false,
    );
  });

  it("does not force running while auto-flushing a paused queue", async () => {
    useMessagesStore.setState({
      runningBySession: { [sessionId]: false },
      queuePausedBySession: { [sessionId]: true },
    });

    useMessagesStore.getState().flushQueue(sessionId);
    await Promise.resolve();

    expect(flushCalls).toEqual([{ sessionId }]);
    expect(useMessagesStore.getState().runningBySession[sessionId]).toBe(false);
  });
});
