import { ApiPaths } from "@zuse/contracts";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

/**
 * Client-side DPoP machinery for the account api (RFC 9449). A per-runtime
 * ES256 keypair proves possession on every request: `POST /v1/client/dpop-token`
 * exchanges a WorkOS bearer + a proof for a DPoP-bound access token, and each
 * DPoP-scoped call then sends `Authorization: DPoP <token>` plus a fresh proof
 * bound to the request method and URL.
 */
export interface DpopClientKey {
	readonly publicJwk: JWK;
	readonly privateKey: Awaited<
		ReturnType<typeof generateKeyPair>
	>["privateKey"];
}

export const createDpopClientKey = async (): Promise<DpopClientKey> => {
	const generated = await generateKeyPair("ES256", { extractable: true });
	return {
		publicJwk: (await exportJWK(generated.publicKey)) as JWK,
		privateKey: generated.privateKey,
	};
};

export const signDpopProof = (
	key: DpopClientKey,
	method: string,
	url: string,
): Promise<string> =>
	new SignJWT({
		htm: method,
		htu: url,
		jti: crypto.randomUUID(),
	})
		.setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.publicJwk })
		.setIssuedAt()
		.sign(key.privateKey);

/**
 * The `POST /v1/client/dpop-token` grant: WorkOS bearer proves the account,
 * the proof binds the minted token to this runtime's key. The caller maps the
 * response status and decodes the body.
 */
export const fetchDpopAccessToken = async (input: {
	readonly apiUrl: string;
	readonly workosToken: string;
	readonly key: DpopClientKey;
	readonly signal?: AbortSignal;
}): Promise<Response> => {
	const target = `${input.apiUrl}${ApiPaths.dpopToken}`;
	return fetch(target, {
		method: "POST",
		headers: {
			authorization: `Bearer ${input.workosToken}`,
			dpop: await signDpopProof(input.key, "POST", target),
		},
		signal: input.signal,
	});
};
