import type { WorkosAccount } from "../auth/workos.ts";

export type MobilePlatform = "ios" | "android" | "web";

export interface PushRegistrationDeps {
	readonly apiUrl: () => string;
	readonly platform: MobilePlatform;
	readonly getDeviceId: () => Promise<string>;
	readonly getPushToken: () => Promise<string | null>;
	readonly registerDevice: (input: {
		readonly deviceId: string;
		readonly platform: "ios" | "android";
		readonly pushToken: string;
	}) => Promise<void>;
}

export const shouldRegisterPushToken = (input: {
	readonly signedIn: boolean;
	readonly apiUrl: string;
	readonly platform: MobilePlatform;
}): boolean =>
	input.signedIn &&
	input.apiUrl.trim().length > 0 &&
	(input.platform === "ios" || input.platform === "android");

export const registerPushTokenForAccount = async (
	account: WorkosAccount | null,
	deps: PushRegistrationDeps,
): Promise<boolean> => {
	const platform = deps.platform;
	if (
		!shouldRegisterPushToken({
			signedIn: account !== null,
			apiUrl: deps.apiUrl(),
			platform,
		})
	) {
		throw new Error(
			"Push registration requires a signed-in account and a configured API on a mobile device.",
		);
	}
	if (platform !== "ios" && platform !== "android") {
		throw new Error("Push registration requires a mobile device.");
	}

	const token = await deps.getPushToken();
	if (token === null) return false;

	await deps.registerDevice({
		deviceId: await deps.getDeviceId(),
		platform,
		pushToken: token,
	});
	return true;
};
