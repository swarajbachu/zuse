import { Context, type Effect, Schema } from "effect";

import type {
  AuthTokenId,
  AuthTokenSummary,
  EnvironmentEndpoint,
  EnvironmentId,
} from "@zuse/contracts";

import type { LanAuthPolicy } from "../policy.ts";

export interface LanAuthConfigShape {
  readonly policy: LanAuthPolicy;
  readonly advertisedHost: string | null;
  readonly port: number | null;
  readonly pairingBootstrap: boolean;
}

export class LanAuthConfig extends Context.Service<
  LanAuthConfig,
  LanAuthConfigShape
>()("zuse/LanAuthConfig") {}

export class LanAuthError extends Schema.TaggedErrorClass<LanAuthError>()(
  "LanAuthError",
  { reason: Schema.String },
) {}

export class PairingRedeemError extends Schema.TaggedErrorClass<PairingRedeemError>()(
  "PairingRedeemError",
  { reason: Schema.Literals(["invalid_code", "expired_code"]) },
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
  /**
   * The environment's Ed25519 keypair (generated + persisted on first use). The
   * private JWK signs link proofs; the public JWK is sent to the relay so it can
   * verify them.
   */
  readonly environmentKeys: () => Effect.Effect<
    {
      readonly envId: EnvironmentId;
      readonly privateJwk: string;
      readonly publicJwk: string;
    },
    LanAuthError
  >;
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
    readonly label?: string;
    /** `cloudflared` connector token for the managed tunnel, if provisioned. */
    readonly connectorToken?: string;
    /** Public hostname for the managed tunnel, if provisioned. */
    readonly tunnelHostname?: string;
    /** Relay Ed25519 public key (JWK JSON) for verifying relay connect JWTs. */
    readonly mintPublicKey?: string;
  }) => Effect.Effect<void, LanAuthError>;
  /** Current relay link, or null if this environment isn't linked. */
  readonly getRelayConfig: () => Effect.Effect<
    {
      readonly relayUrl: string;
      readonly relayIssuer: string;
      readonly environmentId: EnvironmentId;
      readonly environmentCredential: string;
      readonly label: string | undefined;
      readonly connectorToken: string | undefined;
      readonly tunnelHostname: string | undefined;
      readonly mintPublicKey: string | undefined;
    } | null,
    LanAuthError
  >;
  /** Remove the relay link for this environment. */
  readonly clearRelayConfig: () => Effect.Effect<void, LanAuthError>;
}

export class LanAuthService extends Context.Service<
  LanAuthService,
  LanAuthServiceShape
>()("zuse/LanAuthService") {}
