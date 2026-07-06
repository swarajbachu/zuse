import * as SecureStore from "expo-secure-store";
import { calculateJwkThumbprint, type JWK } from "jose";

/**
 * Device DPoP key (RFC 9449). A per-install ES256 keypair proves possession of
 * the key on every relay call; the relay binds minted access tokens to its
 * thumbprint. Requires WebCrypto — provided by react-native-quick-crypto's
 * `install()` in polyfills.ts (Expo Go won't have it; use a dev client).
 */
const PRIVATE_KEY = "zuse.mobile.dpop.private.v1";
const PUBLIC_KEY = "zuse.mobile.dpop.public.v1";

interface DeviceKey {
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
}

let cached: DeviceKey | null = null;

const loadOrCreate = async (): Promise<DeviceKey> => {
  if (cached !== null) return cached;
  const [priv, pub] = await Promise.all([
    SecureStore.getItemAsync(PRIVATE_KEY),
    SecureStore.getItemAsync(PUBLIC_KEY),
  ]);
  if (priv !== null && pub !== null) {
    cached = {
      privateJwk: JSON.parse(priv) as JWK,
      publicJwk: JSON.parse(pub) as JWK,
    };
    return cached;
  }
  const { privateKey, publicKey } = await subtle().generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = normalizePrivateJwk(
    await subtle().exportKey("jwk", privateKey),
  );
  const publicJwk = normalizePublicJwk(
    await subtle().exportKey("jwk", publicKey),
  );
  await Promise.all([
    SecureStore.setItemAsync(PRIVATE_KEY, JSON.stringify(privateJwk)),
    SecureStore.setItemAsync(PUBLIC_KEY, JSON.stringify(publicJwk)),
  ]);
  cached = { privateJwk, publicJwk };
  return cached;
};

export const devicePublicJwk = async (): Promise<JWK> =>
  (await loadOrCreate()).publicJwk;

export const deviceThumbprint = async (): Promise<string> =>
  calculateJwkThumbprint(await devicePublicJwk());

/**
 * Build a DPoP proof JWS for a specific request. `htm`/`htu` bind it to this
 * method + URL; a fresh `jti` makes it single-use (the relay rejects replays).
 */
export const signDpopProof = async (input: {
  readonly method: string;
  readonly url: string;
}): Promise<string> => {
  const { privateJwk, publicJwk } = await loadOrCreate();
  const protectedHeader = {
    alg: "ES256",
    typ: "dpop+jwt",
    jwk: publicJwk,
  };
  const payload = {
    htm: input.method.toUpperCase(),
    htu: normalizeUrl(input.url),
    jti: cryptoRandomId(),
    iat: Math.floor(Date.now() / 1000),
  };
  const signingInput = `${base64UrlJson(protectedHeader)}.${base64UrlJson(payload)}`;
  const key = await subtle().importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
};

const subtle = (): SubtleCrypto => {
  const crypto = globalThis.crypto;
  if (crypto?.subtle === undefined) {
    throw new Error("mobile_crypto_unavailable");
  }
  return crypto.subtle;
};

const normalizePrivateJwk = (jwk: JsonWebKey): JWK => ({
  kty: "EC",
  crv: "P-256",
  alg: "ES256",
  key_ops: ["sign"],
  ext: true,
  x: requiredJwkPart(jwk.x, "x"),
  y: requiredJwkPart(jwk.y, "y"),
  d: requiredJwkPart(jwk.d, "d"),
});

const normalizePublicJwk = (jwk: JsonWebKey): JWK => ({
  kty: "EC",
  crv: "P-256",
  alg: "ES256",
  key_ops: ["verify"],
  ext: true,
  x: requiredJwkPart(jwk.x, "x"),
  y: requiredJwkPart(jwk.y, "y"),
});

const requiredJwkPart = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) {
    throw new Error(`mobile_dpop_jwk_missing_${name}`);
  }
  return value;
};

const base64UrlJson = (value: unknown): string =>
  base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));

const base64UrlBytes = (bytes: Uint8Array): string => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    output += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    output += alphabet[c & 63]!;
  }
  return output;
};

const normalizeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
};

const cryptoRandomId = (): string => {
  // crypto.randomUUID is available once react-native-quick-crypto is installed.
  const maybe = (globalThis.crypto as { randomUUID?: () => string } | undefined)
    ?.randomUUID;
  if (typeof maybe === "function") return maybe.call(globalThis.crypto);
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};
