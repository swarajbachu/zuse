/**
 * MIME → on-disk extension. Used so blobs land with a sensible extension for
 * human debuggability. Falls back to "bin" for unknown types — the original
 * filename's extension is preferred when available (see `extForUpload`).
 */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "application/zip": "zip",
};

export const extForMime = (mimeType: string): string =>
  EXT_BY_MIME[mimeType.toLowerCase()] ?? "bin";

/**
 * Pick the on-disk extension for a freshly uploaded attachment. Prefer the
 * original filename's extension (so a `.docx` stays a `.docx`); otherwise
 * derive from the MIME type table; otherwise fall back to "bin".
 */
export const extForUpload = (mimeType: string, originalName: string): string => {
  const dot = originalName.lastIndexOf(".");
  if (dot > 0 && dot < originalName.length - 1) {
    const ext = originalName.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return extForMime(mimeType);
};

export const isImageMime = (mimeType: string): boolean =>
  mimeType.toLowerCase().startsWith("image/");
