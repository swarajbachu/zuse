import { AuthenticationError, Cursor, CursorSdkError } from "@cursor/sdk";
import { Duration, Effect } from "effect";

export type ApiKeyValidationResult =
  | { readonly status: "verified" }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unverified"; readonly warning: string };

const DEFAULT_INVALID_REASON =
  "The API key was rejected. Check the key and try again.";
const DEFAULT_UNVERIFIED_WARNING =
  "The API key was saved, but it could not be verified. Check your connection and recheck the provider when online.";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Classify SDK failures without treating connectivity or service faults as bad keys. */
export const classifyApiKeyValidationError = (
  cause: unknown,
): ApiKeyValidationResult => {
  const message = messageOf(cause);
  const explicitAuthenticationFailure =
    cause instanceof AuthenticationError ||
    (cause instanceof CursorSdkError && cause.status === 401) ||
    /(?:invalid|expired|revoked).*api key|api key.*(?:invalid|expired|revoked)|unauthori[sz]ed|\b401\b/i.test(
      message,
    );
  return explicitAuthenticationFailure
    ? { status: "invalid", reason: DEFAULT_INVALID_REASON }
    : { status: "unverified", warning: DEFAULT_UNVERIFIED_WARNING };
};

/**
 * Verify a candidate key through the SDK catalog endpoint. The secret is
 * passed explicitly on the request and is never read from the environment.
 */
export const validateApiKey = (
  apiKey: string,
): Effect.Effect<ApiKeyValidationResult> =>
  Effect.tryPromise({
    try: () => Cursor.models.list({ apiKey }),
    catch: (cause) => cause,
  }).pipe(
    Effect.as({ status: "verified" as const }),
    Effect.timeoutOption(Duration.seconds(8)),
    Effect.map((result) =>
      result._tag === "Some"
        ? result.value
        : {
            status: "unverified" as const,
            warning: DEFAULT_UNVERIFIED_WARNING,
          },
    ),
    Effect.catch((cause) =>
      Effect.succeed(classifyApiKeyValidationError(cause)),
    ),
  );
