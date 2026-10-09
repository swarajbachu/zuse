import { CLOUD_WORKSPACE_OFFER_ID } from "@zuse/contracts";
import { CLOUD_CHECKOUT_STARTED } from "./cloud-onboarding.ts";
import { runCloudControl } from "./control-plane-client.ts";
import { openExternal } from "./platform-capabilities.ts";

/**
 * Opens Cloud checkout in the browser; callers handle errors. Kept out of the
 * startup-loaded onboarding module so its imports stay off the startup route.
 */
export const startCloudCheckout = (): Promise<void> =>
	openExternal(async () => {
		const result = await runCloudControl((client) =>
			client["machines.checkout"]({ offerId: CLOUD_WORKSPACE_OFFER_ID }),
		);
		window.dispatchEvent(new Event(CLOUD_CHECKOUT_STARTED));
		return result.checkoutUrl;
	});
