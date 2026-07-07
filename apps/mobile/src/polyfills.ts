import { Effect } from "effect";
// Installs a WebCrypto (crypto.subtle + randomUUID) implementation so `jose`
// can generate ES256 device keys and sign DPoP proofs on React Native.
import { install as installQuickCrypto } from "react-native-quick-crypto";
import * as TextEncoding from "text-encoding";

type TextEncodingModule = {
  TextEncoder: typeof globalThis.TextEncoder;
  TextDecoder: typeof globalThis.TextDecoder;
};

export const installPolyfills = Effect.try({
  try: () => {
    if (
      typeof globalThis.TextEncoder === "undefined" ||
      typeof globalThis.TextDecoder === "undefined"
    ) {
      const textEncoding = TextEncoding as TextEncodingModule;
      globalThis.TextEncoder ??= textEncoding.TextEncoder;
      globalThis.TextDecoder ??= textEncoding.TextDecoder;
    }
    if (
      typeof globalThis.crypto === "undefined" ||
      typeof globalThis.crypto.subtle === "undefined"
    ) {
      installQuickCrypto();
    }
  },
  catch: (cause) => cause
});

void Effect.runPromise(installPolyfills);
