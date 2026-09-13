import type { RunnerEnv } from "./runner.ts";
import { postSlackMessage, SlackApiError, slackApi } from "./slack.ts";

export interface TurnProgress {
	readonly key: string;
	readonly channel: string;
	readonly threadTs: string;
	readonly statusTs?: string;
	readonly startedAt: number;
	readonly phase: string;
	readonly completed?: boolean;
	readonly workspaceId?: string;
}
const TTL = 30 * 24 * 60 * 60;
export const readProgress = async (
	env: RunnerEnv,
	key: string,
): Promise<TurnProgress | null> => {
	const raw = await env.THREADS.get(`progress:${key}`);
	return raw ? JSON.parse(raw) : null;
};
export const saveProgress = (env: RunnerEnv, progress: TurnProgress) =>
	env.THREADS.put(`progress:${progress.key}`, JSON.stringify(progress), {
		expirationTtl: TTL,
	});

export const attachWorkspace = async (
	env: RunnerEnv,
	key: string,
	workspaceId: string,
) => {
	const progress = await readProgress(env, key);
	if (progress && !progress.completed)
		await saveProgress(env, { ...progress, workspaceId });
};

const nativeStatus = async (
	env: RunnerEnv,
	channel: string,
	threadTs: string,
	status: string,
) => {
	return env.setStatus(channel, threadTs, status);
};

export const startProgress = async (
	env: RunnerEnv,
	input: { key: string; channel: string; threadTs: string },
): Promise<TurnProgress> => {
	const existing = await readProgress(env, input.key);
	if (existing) return existing;
	const phase = "Zusing…";
	const native = await nativeStatus(env, input.channel, input.threadTs, phase);
	const message = native
		? undefined
		: await postSlackMessage({
				botToken: env.SLACK_BOT_TOKEN,
				channel: input.channel,
				threadTs: input.threadTs,
				text: `:hourglass_flowing_sand: ${phase}`,
				idempotencyKey: `${env.NAMESPACE}:progress:${input.key}`,
			});
	const progress = {
		...input,
		statusTs: message?.ts,
		startedAt: Date.now(),
		phase,
	};
	await saveProgress(env, progress);
	return progress;
};

export const refreshStatus = async (
	env: RunnerEnv,
	key: string,
	phase: string,
): Promise<boolean> => {
	const progress = await readProgress(env, key);
	if (!progress) return false;
	const native = await nativeStatus(
		env,
		progress.channel,
		progress.threadTs,
		progress.completed ? "" : phase,
	);
	// Completion may arrive while the Slack call is in flight. Do not revive its spinner.
	if (!progress.completed && (await readProgress(env, key))?.completed)
		await nativeStatus(env, progress.channel, progress.threadTs, "");
	return native;
};

/** Only used before sending the turn; polling never edits a potentially completed answer. */
export const updateProgress = async (
	env: RunnerEnv,
	key: string,
	phase: string,
): Promise<void> => {
	const progress = await readProgress(env, key);
	if (!progress || progress.completed) return;
	const native = await refreshStatus(env, key, phase);
	if ((await readProgress(env, key))?.completed) return;
	let statusTs = progress.statusTs;
	if (native) {
		if (statusTs) {
			try {
				await slackApi(env.SLACK_BOT_TOKEN, "chat.delete", {
					channel: progress.channel,
					ts: statusTs,
				});
			} catch (error) {
				if (
					!(error instanceof SlackApiError) ||
					error.code !== "message_not_found"
				)
					throw error;
			}
			statusTs = undefined;
		}
	} else if (!statusTs) {
		const message = await postSlackMessage({
			botToken: env.SLACK_BOT_TOKEN,
			channel: progress.channel,
			threadTs: progress.threadTs,
			text: `:hourglass_flowing_sand: ${phase}`,
			idempotencyKey: `${env.NAMESPACE}:progress:${key}:${phase}`,
		});
		statusTs = message.ts;
	} else if (progress.phase !== phase)
		await slackApi(env.SLACK_BOT_TOKEN, "chat.update", {
			channel: progress.channel,
			ts: progress.statusTs,
			text: `:hourglass_flowing_sand: ${phase}…`,
			unfurl_links: false,
			unfurl_media: false,
		});
	await saveProgress(env, { ...progress, phase, statusTs });
};

export const finishProgress = async (
	env: RunnerEnv,
	key: string,
	text: string,
	outcome: "completed" | "failed" = "completed",
	settled = true,
): Promise<boolean> => {
	const progress = await readProgress(env, key);
	if (!progress) return false;
	if (!progress.completed) {
		const body = {
			channel: progress.channel,
			ts: progress.statusTs,
			text: `${outcome === "failed" ? ":warning:" : ":white_check_mark:"} ${outcome === "failed" ? "Needs attention" : "Done"}\n\n${text.length > 38000 ? `${text.slice(0, 38000)}\n_(Reply truncated; read the full result in Zuse.)_` : text}${progress.workspaceId ? `\n\nWorkspace: \`${progress.workspaceId}\`` : ""}`,
			unfurl_links: false,
			unfurl_media: false,
		};
		let statusTs = progress.statusTs;
		if (statusTs)
			try {
				await slackApi(env.SLACK_BOT_TOKEN, "chat.update", body);
			} catch (error) {
				if (
					!(error instanceof SlackApiError) ||
					!["message_not_found", "cant_update_message"].includes(error.code)
				)
					throw error;
				statusTs = undefined;
			}
		if (!statusTs) {
			const replacement = await postSlackMessage({
				botToken: env.SLACK_BOT_TOKEN,
				channel: progress.channel,
				threadTs: progress.threadTs,
				text: body.text,
				idempotencyKey: `${env.NAMESPACE}:result:${key}:${settled ? "settled" : "notice"}`,
			});
			statusTs = replacement.ts;
		}
		await saveProgress(env, {
			...progress,
			statusTs,
			phase: outcome,
			completed: settled,
		});
	}
	await nativeStatus(env, progress.channel, progress.threadTs, "");
	return true;
};
