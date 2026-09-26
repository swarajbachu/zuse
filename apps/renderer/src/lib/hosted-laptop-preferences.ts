import { parseEnvironmentRoute } from "@zuse/client-runtime/environment-scope";
export type HostedLaptopPreference = {
	enabled: boolean;
	environmentId: string | null;
};
export const hostedLaptopPreferenceKey = (accountId: string | null): string =>
	`zuse.hosted.laptop:${accountId}`;
export const resolveHostedLaptopPreference = (
	pathname: string,
	stored: string | null,
): HostedLaptopPreference => {
	const route = parseEnvironmentRoute(pathname);
	if (route) return { enabled: true, environmentId: route.environmentId };
	try {
		const value: unknown = JSON.parse(stored ?? "null");
		if (typeof value !== "object" || value === null)
			return { enabled: false, environmentId: null };
		return {
			enabled: Reflect.get(value, "enabled") === true,
			environmentId:
				typeof Reflect.get(value, "environmentId") === "string"
					? Reflect.get(value, "environmentId")
					: null,
		};
	} catch {
		return { enabled: false, environmentId: null };
	}
};
