import { Context, type Effect, Schema } from "effect";

import type {
  AuthTokenId,
  AuthTokenSummary,
  EnvironmentEndpoint,
  EnvironmentId,
} from "@zuse/wire";

import type { LanAuthPolicy } from "../policy.ts";

export interface LanAuthConfigShape {
  readonly policy: LanAuthPolicy;
  readonly advertisedHost: string | null;
  readonly port: number | null;
  readonly pairingBootstrap: boolean;
}

export class LanAuthConfig extends Context.Tag("zuse/LanAuthConfig")<
  LanAuthConfig,
  LanAuthConfigShape
>() {}

export class LanAuthError extends Schema.TaggedError<LanAuthError>()(
  "LanAuthError",
  { reason: Schema.String },
) {}

export class PairingRedeemError extends Schema.TaggedError<PairingRedeemError>()(
  "PairingRedeemError",
  { reason: Schema.Literal("invalid_code", "expired_code") },
) {}

export interface LanAuthServiceShape {
  readonly policy: LanAuthPolicy;
  readonly pairingBootstrap: boolean;
  readonly mintToken: (
    label?: string,
  ) => Effect.Effect<
    { readonly id: AuthTokenId; readonly token: string },
    LanAuthError
  >;
  readonly verifyToken: (token: string) => Effect.Effect<boolean, LanAuthError>;
  readonly listTokens: () => Effect.Effect<
    ReadonlyArray<AuthTokenSummary>,
    LanAuthError
  >;
  readonly revokeToken: (id: AuthTokenId) => Effect.Effect<void, LanAuthError>;
  readonly hasActiveTokens: () => Effect.Effect<boolean, LanAuthError>;
  readonly createPairingCode: () => Effect.Effect<
    {
      readonly code: string;
      readonly expiresAt: Date;
      readonly pairingUrl: string;
      readonly qrText: string;
    },
    LanAuthError
  >;
  readonly redeemPairingCode: (
    code: string,
  ) => Effect.Effect<
    { readonly token: string; readonly environmentId: EnvironmentId },
    PairingRedeemError | LanAuthError
  >;
  readonly environmentId: () => Effect.Effect<EnvironmentId, LanAuthError>;
  readonly linkProof: (input: {
    readonly challenge: string;
    readonly relayIssuer: string;
    readonly endpoint: EnvironmentEndpoint;
  }) => Effect.Effect<{ readonly proof: string }, LanAuthError>;
  readonly saveRelayConfig: (input: {
    readonly relayUrl: string;
    readonly relayIssuer: string;
    readonly environmentId: EnvironmentId;
    readonly environmentCredential: string;
  }) => Effect.Effect<void, LanAuthError>;
}

export class LanAuthService extends Context.Tag("zuse/LanAuthService")<
  LanAuthService,
  LanAuthServiceShape
>() {}
