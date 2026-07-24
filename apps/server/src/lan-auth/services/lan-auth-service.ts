import type {
	AuthTokenId,
	AuthTokenSummary,
	EnvironmentEndpoint,
	EnvironmentId,
} from "@zuse/contracts";
import { Context, type Effect, Schema } from "effect";

import type { LanAuthPolicy } from "../policy.ts";

export interface LanAuthConfigShape {
	readonly policy: LanAuthPolicy;
	readonly advertisedHost: string | null;
	readonly port: number | null;
	readonly pairingBootstrap: boolean;
	readonly icloudTrustRecordId?: string;
	readonly icloudTrustSecret?: string;
	readonly transportCertificatePin?: string;
	readonly onNearbyPairingRequest?: (request: NearbyPairingRequest) => void;
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

export type NearbyPairingRequest = {
	readonly requestId: string;
	readonly deviceId: string;
	readonly deviceLabel: string;
	readonly deviceModel?: string;
	readonly deviceIdentifier: string;
	readonly devicePublicKey: string;
	readonly ephemeralPublicKey: string;
	readonly clientNonce: string;
	readonly serverNonce: string;
	readonly safetyPhrase: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
};

export type NearbyPairingStatus =
	| { readonly state: "pending" }
	| { readonly state: "denied" }
	| { readonly state: "expired" }
	| {
			readonly state: "approved";
			readonly credential: {
				readonly ephemeralPublicKey: string;
				readonly nonce: string;
				readonly ciphertext: string;
			};
	  };

export interface LanAuthServiceShape {
	readonly policy: LanAuthPolicy;
	readonly pairingBootstrap: boolean;
	readonly mintToken: (
		label?: string,
		deviceId?: string,
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
			readonly browserUrl: string;
			readonly qrText: string;
		},
		LanAuthError
	>;
	readonly redeemPairingCode: (
		code: string,
		device?: {
			readonly id: string;
			readonly label?: string;
		},
	) => Effect.Effect<
		{
			readonly token: string;
			readonly environmentId: EnvironmentId;
			readonly environmentPublicKey: string;
			readonly transportCertificatePin?: string;
		},
		PairingRedeemError | LanAuthError
	>;
	readonly requestNearbyPairing: (input: {
		readonly deviceId: string;
		readonly deviceLabel: string;
		readonly deviceModel?: string;
		readonly devicePublicKey: string;
		readonly ephemeralPublicKey: string;
		readonly clientNonce: string;
		readonly icloudTrustRecordId?: string;
		readonly icloudTrustProof?: string;
		readonly serverNonce: string;
		readonly accountAssertion?: string;
	}) => Effect.Effect<NearbyPairingRequest, LanAuthError>;
	readonly createNearbyPairingChallenge: () => Effect.Effect<
		{
			readonly serverNonce: string;
			readonly environmentPublicKey: string;
			readonly environmentId: EnvironmentId;
			readonly transportCertificatePin?: string;
			readonly expiresAt: Date;
		},
		LanAuthError
	>;
	readonly listNearbyPairingRequests: () => Effect.Effect<
		ReadonlyArray<NearbyPairingRequest>,
		LanAuthError
	>;
	readonly resolveNearbyPairingRequest: (input: {
		readonly requestId: string;
		readonly decision: "allow" | "deny" | "block";
	}) => Effect.Effect<"approved" | "denied", LanAuthError>;
	readonly nearbyPairingStatus: (
		requestId: string,
	) => Effect.Effect<NearbyPairingStatus, LanAuthError>;
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
