import { Effect } from "effect";
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
  },
  catch: (cause) => cause
});

void Effect.runPromise(installPolyfills);
