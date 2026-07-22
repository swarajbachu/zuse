/** Keep timeline overlays above the measured floating composer. */
export const resolveChatErrorBottom = (composerInset: number): number =>
	Math.max(0, composerInset);
