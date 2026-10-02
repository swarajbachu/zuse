import { mobileCloudChatLinkRoute } from "~/lib/cloud-chat-link";
import { notificationRoute } from "~/notifications/route";

export function redirectSystemPath({
	path,
}: {
	path: string;
	initial: boolean;
}): string {
	return mobileCloudChatLinkRoute(path) ?? notificationRoute(path) ?? path;
}
