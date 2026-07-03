import { Effect } from "effect";

import { NotImplemented } from "./errors";

export const sendMessage = () =>
  Effect.fail(new NotImplemented({ action: "messages.send" }));

export const interruptSession = () =>
  Effect.fail(new NotImplemented({ action: "messages.interrupt" }));

export const approvePermission = () =>
  Effect.fail(new NotImplemented({ action: "permission.decide" }));

export const answerQuestion = () =>
  Effect.fail(new NotImplemented({ action: "session.answerQuestion" }));
