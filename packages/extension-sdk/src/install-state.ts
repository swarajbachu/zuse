/** Reconcile a catalog release with the current installed generation. */
export const extensionInstallState = (
	available: { readonly version: string; readonly commit: string },
	current:
		| { readonly version: string; readonly commit: string | null }
		| undefined,
) => ({
	installed: current !== undefined,
	updateAvailable:
		current !== undefined &&
		(current.commit !== available.commit ||
			current.version !== available.version),
});
