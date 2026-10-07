import type { Installation } from "./installations.ts";
import { randomSecret } from "./installations.ts";
import { SlackApiError, SlackRateLimitError, slackApi } from "./slack.ts";
import type { AppEnv, AppJob } from "./types.ts";

const keyFor = (channel: string, messageTs: string, name: string) =>
	`reaction:${channel}:${messageTs}:${name}`;
const unavailable = (error: unknown) =>
	error instanceof SlackApiError &&
	(!error.retryable ||
		[
			"invalid_name",
			"message_not_found",
			"too_many_reactions",
			"no_reaction",
			"not_reactable",
		].includes(error.code));
const send = (
	installation: Installation,
	channel: string,
	messageTs: string,
	name: string,
	active: boolean,
) =>
	slackApi(
		installation.credentials.botToken,
		active ? "reactions.add" : "reactions.remove",
		{ channel, timestamp: messageTs, name },
	);

/** Cosmetic activity cannot fail a task. Cleanup survives transient Slack errors. */
export const setMessageReaction = async (
	env: AppEnv,
	installation: Installation,
	channel: string,
	messageTs: string,
	name: string,
	active: boolean,
): Promise<boolean | "invalid_name"> => {
	const version = randomSecret();
	await env.store
		.state(installation)
		.put(keyFor(channel, messageTs, name), version, { expirationTtl: 86400 });
	try {
		await send(installation, channel, messageTs, name, active);
		return true;
	} catch (error) {
		if (
			error instanceof SlackApiError &&
			error.code === (active ? "already_reacted" : "no_reaction")
		)
			return true;
		if (error instanceof SlackApiError && error.code === "invalid_name")
			return "invalid_name";
		if (!active && !unavailable(error)) {
			await env.JOBS.send(
				{
					kind: "reaction-clear",
					teamId: installation.teamId,
					generation: installation.generation,
					id: `reaction-clear:${version}`,
					channel,
					messageTs,
					name,
					version,
				},
				{
					delaySeconds:
						error instanceof SlackRateLimitError ? error.retryAfterSeconds : 10,
				},
			);
		}
		console.warn("[slack-app] reaction unavailable", {
			name,
			active,
			code: error instanceof SlackApiError ? error.code : "temporary_failure",
		});
		return false;
	}
};

export const retryReactionClear = async (
	env: AppEnv,
	installation: Installation,
	job: Extract<AppJob, { kind: "reaction-clear" }>,
) => {
	if (
		(await env.store
			.state(installation)
			.get(keyFor(job.channel, job.messageTs, job.name))) !== job.version
	)
		return;
	try {
		await send(installation, job.channel, job.messageTs, job.name, false);
	} catch (error) {
		if (!unavailable(error)) throw error;
	}
};
