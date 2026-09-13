import type { AppJob } from "@zuse/slack/types";
import { isConfigured } from "../environment.ts";

export interface SlackBindings {
	readonly SLACK_ENABLED?: string;
	readonly SLACK_PUBLIC_ORIGIN?: string;
	readonly SLACK_APP_ID?: string;
	readonly SLACK_CLIENT_ID?: string;
	readonly SLACK_CLIENT_SECRET?: string;
	readonly SLACK_SIGNING_SECRET?: string;
	readonly SLACK_JOBS?: {
		send(job: AppJob, options?: { delaySeconds: number }): Promise<void>;
	};
}

export const resolveSlackConfiguration = (
	env: SlackBindings,
	encryptionConfigured: boolean,
) => {
	if (env.SLACK_ENABLED !== "true") return undefined;
	const {
		SLACK_APP_ID,
		SLACK_PUBLIC_ORIGIN,
		SLACK_CLIENT_ID,
		SLACK_CLIENT_SECRET,
		SLACK_SIGNING_SECRET,
		SLACK_JOBS,
	} = env;
	if (
		!isConfigured(SLACK_APP_ID) ||
		!isConfigured(SLACK_PUBLIC_ORIGIN) ||
		!isConfigured(SLACK_CLIENT_ID) ||
		!isConfigured(SLACK_CLIENT_SECRET) ||
		!isConfigured(SLACK_SIGNING_SECRET) ||
		!SLACK_JOBS ||
		!encryptionConfigured
	)
		throw new Error(
			"SLACK_ENABLED requires Slack credentials, SLACK_JOBS and CLOUD_DATA_ENCRYPTION_KEY",
		);
	return {
		publicOrigin: SLACK_PUBLIC_ORIGIN,
		appId: SLACK_APP_ID,
		clientId: SLACK_CLIENT_ID,
		clientSecret: SLACK_CLIENT_SECRET,
		signingSecret: SLACK_SIGNING_SECRET,
		queue: SLACK_JOBS,
	};
};
