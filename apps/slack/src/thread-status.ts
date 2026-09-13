import type { Installation } from "./installations.ts";
import { randomSecret } from "./installations.ts";
import { SlackApiError, SlackRateLimitError, slackApi } from "./slack.ts";
import type { AppEnv, AppJob } from "./types.ts";

const keyFor = (channel: string, threadTs: string) =>
	`native-status:${channel}:${threadTs}`;
const unavailable = (error: unknown) =>
	error instanceof SlackApiError &&
	(!error.retryable ||
		["feature_disabled", "not_supported", "unknown_method"].includes(
			error.code,
		));

const sendStatus = (
	installation: Installation,
	channel: string,
	threadTs: string,
	status: string,
) =>
	slackApi(installation.credentials.botToken, "assistant.threads.setStatus", {
		channel_id: channel,
		thread_ts: threadTs,
		status,
		...(status ? { loading_messages: [status] } : {}),
	});

/** Activity is best effort; failed cleanup must survive the task that just finished. */
export const setThreadStatus = async (
	env: AppEnv,
	installation: Installation,
	channel: string,
	threadTs: string,
	status: string,
) => {
	const version = randomSecret();
	await env.store
		.state(installation)
		.put(keyFor(channel, threadTs), version, { expirationTtl: 86400 });
	try {
		await sendStatus(installation, channel, threadTs, status);
		return true;
	} catch (error) {
		if (unavailable(error)) {
			console.warn("[slack-app] native status unavailable", {
				code: error instanceof SlackApiError ? error.code : "unknown",
			});
			return false;
		}
		if (status) return false; // The durable progress card is the activity fallback.
		await env.JOBS.send(
			{
				kind: "status-clear",
				teamId: installation.teamId,
				generation: installation.generation,
				id: `status-clear:${version}`,
				channel,
				threadTs,
				version,
			},
			{
				delaySeconds:
					error instanceof SlackRateLimitError ? error.retryAfterSeconds : 10,
			},
		);
		return false;
	}
};

export const retryStatusClear = async (
	env: AppEnv,
	installation: Installation,
	job: Extract<AppJob, { kind: "status-clear" }>,
) => {
	// A later status supersedes this cleanup, including another task in the same thread.
	if (
		(await env.store
			.state(installation)
			.get(keyFor(job.channel, job.threadTs))) !== job.version
	)
		return;
	try {
		await sendStatus(installation, job.channel, job.threadTs, "");
	} catch (error) {
		if (!unavailable(error)) throw error;
		console.warn("[slack-app] native status cleanup unavailable", {
			code: error instanceof SlackApiError ? error.code : "unknown",
		});
	}
};
