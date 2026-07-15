import { describe, expect, it } from "vitest";

import {
  bytesForImageContent,
  imageMimeForFile,
} from "../../src/lib/image-preview.ts";

describe("image preview helpers", () => {
  it("recognizes supported image extensions case-insensitively", () => {
    expect(imageMimeForFile("preview.JPG")).toBe("image/jpeg");
    expect(imageMimeForFile("animation.GIF")).toBe("image/gif");
    expect(imageMimeForFile("diagram.svg")).toBeNull();
  });

  it("preserves binary image bytes", () => {
    const bytes = new Uint8Array([0, 255, 1, 2]);
    expect(bytesForImageContent({ kind: "binary", bytes })).toBe(bytes);
  });

  it("restores image bytes that passed strict UTF-8 decoding", () => {
    const gifHeader = "GIF89a";
    expect(
      bytesForImageContent({ kind: "text", content: gifHeader }),
    ).toEqual(new TextEncoder().encode(gifHeader));
  });
});
