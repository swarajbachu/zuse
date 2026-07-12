import { Effect } from "effect";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";

import type { EnvironmentId } from "@zuse/contracts";

/**
 * The environment's asymmetric identity for relay linking. The private key never
 * leaves the desktop; the public key is handed to the relay, which verifies
 * every proof (link, and later health/connect) against it. Ed25519 is required
 * because the relay must verify without holding a shared secret — see
 * specs/remote-multiclient.
 */
export interface EnvironmentKeypair {
  readonly privateJwk: string;
  readonly publicJwk: string;
}

export const generateEnvironmentKeypair = (): Effect.Effect<EnvironmentKeypair> =>
  Effect.promise(async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
      extractable: true,
    });
    return {
      privateJwk: JSON.stringify(await exportJWK(privateKey)),
      publicJwk: JSON.stringify(await exportJWK(publicKey)),
    };
  });

/**
 * Sign the Ed25519 link proof: a JWT over { challenge, environmentId } with
 * `aud = relayIssuer` and `typ = "environment-link-proof+jwt"`, exactly what the
 * relay's verifier checks.
 */
export const signEnvironmentLinkProof = (input: {
  readonly privateJwk: string;
  readonly challenge: string;
  readonly environmentId: EnvironmentId;
  readonly relayIssuer: string;
  readonly nowMs: number;
}): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await importJWK(
      JSON.parse(input.privateJwk) as Record<string, unknown>,
      "EdDSA",
    );
    return new SignJWT({
      challenge: input.challenge,
      environmentId: input.environmentId,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "environment-link-proof+jwt" })
      .setAudience(input.relayIssuer)
      .setIssuedAt(Math.floor(input.nowMs / 1000))
      .setExpirationTime(Math.floor(input.nowMs / 1000) + 300)
      .sign(key);
  });
