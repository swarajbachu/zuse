import * as SecureStore from "expo-secure-store";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";
import QuickCrypto from "react-native-quick-crypto";

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
  const signature = QuickCrypto.createSign("SHA256")
    .update(signingInput)
    .sign({
      key: privateJwk,
      format: "jwk",
      dsaEncoding: "ieee-p1363",
    });
  return `${signingInput}.${base64UrlBytes(toUint8Array(signature))}`;
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

const toUint8Array = (value: string | Uint8Array): Uint8Array => {
  if (typeof value !== "string") return value;
  return new TextEncoder().encode(value);
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
