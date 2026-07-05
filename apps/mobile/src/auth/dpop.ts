import * as SecureStore from "expo-secure-store";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";

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
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
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
  const key = await importJWK(privateJwk, "ES256");
  return new SignJWT({
    htm: input.method.toUpperCase(),
    htu: normalizeUrl(input.url),
    jti: cryptoRandomId(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk })
    .setIssuedAt()
    .sign(key);
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
