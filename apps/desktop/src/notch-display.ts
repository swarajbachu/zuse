export type NotchDisplayLike = {
  readonly bounds: { readonly width: number; readonly height: number };
  readonly size?: { readonly width: number; readonly height: number };
  readonly scaleFactor: number;
  readonly internal?: boolean;
};

export type NotchDisplaySupport =
  | { readonly supported: true; readonly reason: "supported" }
  | {
      readonly supported: false;
      readonly reason: "not-macos" | "no-notched-display";
    };

const NOTCHED_MACBOOK_SIZES = new Set([
  "3024x1964",
  "3456x2234",
  "2560x1664",
  "2880x1864",
]);

const sizeKey = (width: number, height: number): string => {
  const w = Math.round(width);
  const h = Math.round(height);
  return w >= h ? `${w}x${h}` : `${h}x${w}`;
};

export const isLikelyNotchedMacBookDisplay = (
  display: NotchDisplayLike,
): boolean => {
  if (display.internal !== true) return false;
  const candidates = [
    display.size,
    display.bounds,
    {
      width: display.bounds.width * display.scaleFactor,
      height: display.bounds.height * display.scaleFactor,
    },
  ].filter(
    (size): size is { readonly width: number; readonly height: number } =>
      size !== undefined &&
      Number.isFinite(size.width) &&
      Number.isFinite(size.height),
  );
  return candidates.some((size) =>
    NOTCHED_MACBOOK_SIZES.has(sizeKey(size.width, size.height)),
  );
};

export const detectNotchDisplaySupport = (
  platform: NodeJS.Platform,
  displays: ReadonlyArray<NotchDisplayLike>,
): NotchDisplaySupport => {
  if (platform !== "darwin") {
    return { supported: false, reason: "not-macos" };
  }
  return displays.some(isLikelyNotchedMacBookDisplay)
    ? { supported: true, reason: "supported" }
    : { supported: false, reason: "no-notched-display" };
};

export const findNotchedDisplay = <T extends NotchDisplayLike>(
  platform: NodeJS.Platform,
  displays: ReadonlyArray<T>,
): T | null => {
  if (platform !== "darwin") return null;
  return displays.find(isLikelyNotchedMacBookDisplay) ?? null;
};
