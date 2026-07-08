import { Context, type Effect, type Stream } from "effect";

import type {
  MobileAvailability,
  MobileDevice,
  MobileEvent,
  MobileFrame,
  MobileProjectDetection,
  MobileScreenshotError,
  MobileStartError,
  MobileStatus,
  MobileUnsupportedError,
} from "@zuse/wire";

export interface MobileServiceShape {
  readonly availability: () => Effect.Effect<MobileAvailability>;
  readonly listDevices: () => Effect.Effect<
    ReadonlyArray<MobileDevice>,
    MobileUnsupportedError
  >;
  readonly detectProject: (
    cwd: string,
  ) => Effect.Effect<MobileProjectDetection>;
  readonly start: (
    cwd: string,
    udid: string,
    source: "user" | "agent",
  ) => Effect.Effect<void, MobileStartError>;
  readonly stop: () => Effect.Effect<void>;
  readonly status: () => Effect.Effect<MobileStatus>;
  readonly screenshot: (
    source: "user" | "agent",
  ) => Effect.Effect<{ readonly data: string }, MobileScreenshotError>;
  readonly events: () => Stream.Stream<typeof MobileEvent.Type>;
  readonly frames: () => Stream.Stream<MobileFrame>;
  readonly logTail: (lines: number) => Effect.Effect<string>;
}

export class MobileService extends Context.Tag("memoize/MobileService")<
  MobileService,
  MobileServiceShape
>() {}

