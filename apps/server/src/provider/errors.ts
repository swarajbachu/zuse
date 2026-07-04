import { Data } from "effect";

/**
 * Server-internal errors for the provider domain. These never cross the wire
 * — wire-facing errors live in `@zuse/wire`'s `agent.ts`. Each public
 * service method maps these to a wire error before failing.
 */

export class ProviderRegistryError extends Data.TaggedError(
  "ProviderRegistryError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class ProviderAdapterError extends Data.TaggedError(
  "ProviderAdapterError",
)<{
  readonly providerId: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class CredentialsError extends Data.TaggedError("CredentialsError")<{
  readonly providerId: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}
