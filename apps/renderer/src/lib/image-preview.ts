const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const imageMimeForFile = (name: string): string | null => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1
    ? null
    : (IMAGE_MIME_BY_EXTENSION[lower.slice(dot)] ?? null);
};

/** Strict UTF-8 decoding can succeed for some valid image files. Re-encoding
 * that text preserves the original bytes, so both fs result variants preview. */
export const bytesForImageContent = (
  result:
    | { readonly kind: "binary"; readonly bytes: Uint8Array }
    | { readonly kind: "text"; readonly content: string },
): Uint8Array =>
  result.kind === "binary" ? result.bytes : new TextEncoder().encode(result.content);
