import { notificationRoute } from "~/notifications/route";

export function redirectSystemPath({
	path,
}: {
	path: string;
	initial: boolean;
}): string {
	return notificationRoute(path) ?? path;
}
