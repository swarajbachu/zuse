import { rendererPlatformCapabilities } from "./platform-capabilities.ts";

export const cloudMachinesAvailable = ({
	desktop,
	development,
}: {
	readonly desktop: boolean;
	readonly development: boolean;
}): boolean => desktop && development;

/** Cloud compute is an internal desktop beta. Every renderer entry point uses
 * this policy so production users cannot discover a partial cloud route. */
export const cloudWorkspaceBetaAvailable = (): boolean =>
	cloudMachinesAvailable({
		desktop: rendererPlatformCapabilities().desktop,
		development: import.meta.env.DEV,
	});
