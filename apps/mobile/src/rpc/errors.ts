import { Schema } from "effect";

export class ConnectionFailed extends Schema.TaggedError<ConnectionFailed>()(
  "ConnectionFailed",
  { message: Schema.String }
) {}

export class CacheCorrupt extends Schema.TaggedError<CacheCorrupt>()(
  "CacheCorrupt",
  { path: Schema.String, message: Schema.String }
) {}

export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "NotImplemented",
  { action: Schema.String }
) {}
