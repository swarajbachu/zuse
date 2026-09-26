import { isHostedProduct } from "./hosted-connect.ts";
import { rendererPlatformCapabilities } from "./platform-capabilities.ts";

export const cloudMachinesAvailable = ({
	desktop,
}: {
	readonly desktop: boolean;
}): boolean => desktop;

/** Account authorization belongs to the API on desktop and hosted web. */
export const cloudWorkspaceBetaAvailable = (): boolean =>
	isHostedProduct() ||
	cloudMachinesAvailable({
		desktop: rendererPlatformCapabilities().desktop,
	});
