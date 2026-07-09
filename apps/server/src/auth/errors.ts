import { Data } from "effect";

/**
 * Server-internal auth errors. Wire-facing errors (`AuthFlowError`,
 * `AuthCancelledError`) live in `@zuse/wire`'s `auth.ts`. `getAccessToken`
 * — the internal seam future cloud/mobile callers use — fails with
 * `AuthTokenError`; everything renderer-facing is mapped to a wire error by
 * the AuthService before it surfaces.
 */
export class AuthTokenError extends Data.TaggedError("AuthTokenError")<{
  readonly reason: string;
  readonly code?: "invalid_grant";
  readonly cause?: unknown;
}> {}

export class SessionStoreError extends Data.TaggedError("SessionStoreError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}
