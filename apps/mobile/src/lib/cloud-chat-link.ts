import {
	cloudChatRoute,
	parseCloudChatRoute,
} from "@zuse/client-runtime/environment-scope";

/** Normalize only recognized chat locators; never forward arbitrary URLs to a browser. */
export const mobileCloudChatLinkRoute = (target: string): string | null => {
	try {
		let pathname = target;
		if (!target.startsWith("/")) {
			const url = new URL(target);
			if (!["https:", "zuse:", "zuse-dev:"].includes(url.protocol)) return null;
			pathname =
				url.protocol === "https:" || url.hostname === ""
					? url.pathname
					: `/${url.hostname}${url.pathname}`;
		}
		const route = parseCloudChatRoute(pathname);
		return route === null
			? null
			: `/shared-chat?path=${encodeURIComponent(cloudChatRoute(route))}`;
	} catch {
		return null;
	}
};
