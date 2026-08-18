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

/**
 * Notched MacBook Liquid Retina panels are ~3:2:
 *   13" Air  2560×1664  (1.538)
 *   15" Air  2880×1864  (1.545)
 *   14" Pro  3024×1964  (1.540)
 *   16" Pro  3456×2234  (1.547)
 * Pre-notch built-in MacBooks are 16:10 (1.6). iMacs are 16:9 (1.778).
 *
 * Electron reports DIP `size`/`bounds`, not native panel pixels. A 13" Air M2
 * on "More Space" is 1710×1112 @2x (backing 3420×2224), not 2560×1664, so an
 * allowlist of native sizes fails on any non-default scaling. Aspect ratio is
 * invariant under those scaled modes.
 */
const NOTCHED_ASPECT_MIN = 1.53;
const NOTCHED_ASPECT_MAX = 1.56;

const isFinitePositiveSize = (
	size: { readonly width: number; readonly height: number } | undefined,
): size is { readonly width: number; readonly height: number } =>
	size !== undefined &&
	Number.isFinite(size.width) &&
	Number.isFinite(size.height) &&
	size.width !== 0 &&
	size.height !== 0;

const aspectRatio = (width: number, height: number): number => {
	const w = Math.abs(width);
	const h = Math.abs(height);
	const min = Math.min(w, h);
	return min === 0 ? 0 : Math.max(w, h) / min;
};

const isNotchedMacBookSize = (width: number, height: number): boolean => {
	const aspect = aspectRatio(width, height);
	return aspect >= NOTCHED_ASPECT_MIN && aspect <= NOTCHED_ASPECT_MAX;
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
	].filter(isFinitePositiveSize);
	return candidates.some((size) =>
		isNotchedMacBookSize(size.width, size.height),
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
