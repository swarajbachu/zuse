import { Schema } from "effect";

const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const FolderId = makeEntityId("FolderId");
export type FolderId = typeof FolderId.Type;

export const PtyId = makeEntityId("PtyId");
export type PtyId = typeof PtyId.Type;

export const AgentSessionId = makeEntityId("AgentSessionId");
export type AgentSessionId = typeof AgentSessionId.Type;

export const AgentTurnId = makeEntityId("AgentTurnId");
export type AgentTurnId = typeof AgentTurnId.Type;

export const AgentItemId = makeEntityId("AgentItemId");
export type AgentItemId = typeof AgentItemId.Type;

export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;

export const WorktreeId = makeEntityId("WorktreeId");
export type WorktreeId = typeof WorktreeId.Type;

export const ChatId = makeEntityId("ChatId");
export type ChatId = typeof ChatId.Type;

export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;

export const AuthTokenId = makeEntityId("AuthTokenId");
export type AuthTokenId = typeof AuthTokenId.Type;
