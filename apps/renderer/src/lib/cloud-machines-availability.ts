import { rendererPlatformCapabilities } from "./platform-capabilities.ts";

export const cloudMachinesAvailable = ({
	desktop,
}: {
	readonly desktop: boolean;
}): boolean => desktop;

/** Cloud compute is desktop-only. The API owns account authorization. */
export const cloudWorkspaceBetaAvailable = (): boolean =>
	cloudMachinesAvailable({
		desktop: rendererPlatformCapabilities().desktop,
	});
