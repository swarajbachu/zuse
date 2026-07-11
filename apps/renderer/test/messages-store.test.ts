import { beforeEach, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";

import { ComposerInput, QueuedMessage, type SessionId } from "@zuse/contracts";

const { setMessagesRpcClientForTest, useMessagesStore } =
  await import("../src/store/messages.ts");

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
let sendNowCalls: Array<{
  readonly sessionId: SessionId;
  readonly queueId: string;
}> = [];
let resumeCalls: Array<{ readonly sessionId: SessionId }> = [];
let flushCalls: Array<{ readonly sessionId: SessionId }> = [];
let rpcClientFactory: () => Awaited<
  ReturnType<typeof import("../src/lib/rpc-client.ts").getRpcClient>
>;

const makeQueueClient = () =>
  ({
    "messages.interrupt": () =>
      Effect.sync(() => {
        interruptCalls += 1;
      }),
    "messages.queue.sendNow": (payload: {
      readonly sessionId: SessionId;
      readonly queueId: string;
    }) =>
      Effect.sync(() => {
        sendNowCalls.push(payload);
      }),
    "messages.queue.resume": (payload: { readonly sessionId: SessionId }) =>
      Effect.sync(() => {
        resumeCalls.push(payload);
      }),
    "messages.queue.flush": (payload: { readonly sessionId: SessionId }) =>
      Effect.sync(() => {
        flushCalls.push(payload);
      }),
  }) as Awaited<
    ReturnType<typeof import("../src/lib/rpc-client.ts").getRpcClient>
  >;

setMessagesRpcClientForTest(async () => rpcClientFactory());

describe("messages store queue actions", () => {
  beforeEach(() => {
    interruptCalls = 0;
    sendNowCalls = [];
    resumeCalls = [];
    flushCalls = [];
    rpcClientFactory = makeQueueClient;
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

  it("reconnects the active transcript when it is still empty", async () => {
    let streamCalls = 0;
    rpcClientFactory = () =>
      ({
        "session.events": () => {
          streamCalls += 1;
          return streamCalls === 1 ? Stream.never : Stream.empty;
        },
        "messages.queue.stream": () => Stream.empty,
      }) as Awaited<
        ReturnType<typeof import("../src/lib/rpc-client.ts").getRpcClient>
      >;

    await useMessagesStore.getState().hydrate(sessionId);
    await useMessagesStore.getState().hydrate(sessionId);

    expect(streamCalls).toBe(2);
  });
});
