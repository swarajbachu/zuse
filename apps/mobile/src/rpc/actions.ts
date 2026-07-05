import type {
  ComposerInput,
  PermissionDecision,
  SessionId,
} from "@zuse/wire";
import { Effect } from "effect";

import { getConnectionClient } from "./connection";
import type { WsProtocolOptions } from "./ws-protocol";

export const makeTextInput = (text: string): ComposerInput => ({
  text,
  attachments: [],
  fileRefs: [],
  skillRefs: [],
  annotations: [],
});

export const sendMessage = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  input: ComposerInput;
  asGoal?: boolean;
}) =>
  Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    const payload = {
      sessionId: options.sessionId,
      text: options.input.text,
      ...(options.asGoal === undefined ? {} : { asGoal: options.asGoal }),
    };
    yield* client.messages.send(payload);
  });

export const interruptSession = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
}) =>
  Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.messages.interrupt({ sessionId: options.sessionId });
  });

export const decidePermission = (options: {
  connection: WsProtocolOptions;
  requestId: string;
  decision: PermissionDecision;
}) =>
  Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.permission.decide({
      requestId: options.requestId,
      decision: options.decision,
    });
  });

export const answerQuestion = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  itemId: string;
  answers: ReadonlyArray<{
    questionIndex: number;
    selected: ReadonlyArray<number>;
    other?: string;
  }>;
}) =>
  Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.session.answerQuestion({
      sessionId: options.sessionId,
      itemId: options.itemId,
      answers: [...options.answers].map((answer) => ({
        questionIndex: answer.questionIndex,
        selected: [...answer.selected],
        other: answer.other,
      })),
    });
  });
