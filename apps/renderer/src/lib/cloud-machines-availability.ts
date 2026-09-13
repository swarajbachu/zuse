import { rendererPlatformCapabilities } from "./platform-capabilities.ts";

export const cloudMachinesAvailable = ({
	desktop,
}: {
	readonly desktop: boolean;
}): boolean => desktop;

/** Cloud compute is desktop-only. API owns private-beta authorization. */
export const cloudWorkspaceBetaAvailable = (): boolean =>
	cloudMachinesAvailable({
		desktop: rendererPlatformCapabilities().desktop,
	});
