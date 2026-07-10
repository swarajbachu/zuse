import { Schema } from "effect";

export class ConnectionFailed extends Schema.TaggedErrorClass<ConnectionFailed>()(
  "ConnectionFailed",
  { message: Schema.String }
) {}

export class CacheCorrupt extends Schema.TaggedErrorClass<CacheCorrupt>()(
  "CacheCorrupt",
  { path: Schema.String, message: Schema.String }
) {}

export class NotImplemented extends Schema.TaggedErrorClass<NotImplemented>()(
  "NotImplemented",
  { action: Schema.String }
) {}
