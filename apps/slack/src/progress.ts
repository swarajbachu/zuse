import { type ProgressDetails, progressCard } from "./progress-card.ts";
import type { RunnerEnv } from "./runner.ts";
import {
	postSlackMessage,
	SlackApiError,
	SlackRateLimitError,
	slackApi,
} from "./slack.ts";
import { workspaceLink } from "./workspace-link.ts";

export interface TurnProgress {
	readonly key: string;
	readonly channel: string;
	readonly threadTs: string;
	readonly statusTs?: string;
	/** Separate from the result: late activity must never overwrite an answer. */
	readonly activityTs?: string;
	readonly messageTs?: string;
	readonly workingReaction?: string;
	readonly startedAt: number;
	readonly phase: string;
	readonly completed?: boolean;
	readonly workspaceId?: string;
	readonly details?: ProgressDetails;
	readonly waitingForUser?: boolean;
	readonly finishedAt?: number;
}
const TTL = 30 * 24 * 60 * 60;
interface StatusRefresh {
	readonly checkedAt?: number;
	readonly immediate?: boolean;
}
export const readProgress = async (
	env: RunnerEnv,
	key: string,
): Promise<TurnProgress | null> => {
	const raw = await env.THREADS.get(`progress:${key}`);
	if (!raw) return null;
	const progress: TurnProgress = JSON.parse(raw);
	const activityTs =
		progress.activityTs ?? (await env.THREADS.get(`activity:${key}`));
	return activityTs ? { ...progress, activityTs } : progress;
};
export const saveProgress = (env: RunnerEnv, progress: TurnProgress) =>
	env.THREADS.put(`progress:${progress.key}`, JSON.stringify(progress), {
		expirationTtl: TTL,
	});

export const attachWorkspace = async (
	env: RunnerEnv,
	key: string,
	workspaceId: string,
	details?: ProgressDetails,
) => {
	const progress = await readProgress(env, key);
	if (progress && !progress.completed)
		await saveProgress(env, {
			...progress,
			workspaceId,
			details: { ...progress.details, ...details },
		});
	await refreshStatus(env, key, progress?.phase ?? "Preparing your workspace", {
		immediate: true,
	});
};

/** Activity delivery is best effort and must not prevent task submission/results. */
const syncActivity = async (
	env: RunnerEnv,
	progress: TurnProgress,
	options: StatusRefresh = {},
) => {
	try {
		const updateKey = `activity-updated:${progress.key}`;
		const retryAt = Number(
			(await env.THREADS.get(`activity-retry:${progress.key}`)) ?? "0",
		);
		if (retryAt > Date.now()) {
			if (progress.completed)
				throw new SlackRateLimitError(Math.ceil((retryAt - Date.now()) / 1000));
			return;
		}
		let activityTs = progress.activityTs;
		if (!activityTs && !progress.completed) {
			const posted = await postSlackMessage({
				botToken: env.SLACK_BOT_TOKEN,
				channel: progress.channel,
				threadTs: progress.threadTs,
				...progressCard(env, progress, options.checkedAt),
				idempotencyKey: `${env.NAMESPACE}:activity:${progress.key}`,
			});
			activityTs = posted.ts;
			// Store message identity independently: a late post cannot undo settlement.
			await env.THREADS.put(`activity:${progress.key}`, activityTs, {
				expirationTtl: TTL,
			});
			await env.THREADS.put(updateKey, String(Date.now()), {
				expirationTtl: TTL,
			});
			const latest = await readProgress(env, progress.key);
			if (!latest?.completed) return;
		}
		if (!activityTs) return;
		const current = await readProgress(env, progress.key);
		if (!current) return;
		const rendered = current.completed ? current : { ...progress, activityTs };
		if (
			!options.immediate &&
			!rendered.completed &&
			!rendered.waitingForUser &&
			Date.now() - Number((await env.THREADS.get(updateKey)) ?? "0") < 3000
		)
			return;
		const update = (value: TurnProgress) =>
			slackApi(env.SLACK_BOT_TOKEN, "chat.update", {
				channel: progress.channel,
				ts: activityTs,
				...progressCard(env, value, options.checkedAt),
				unfurl_links: false,
				unfurl_media: false,
			});
		await update(rendered);
		await env.THREADS.put(updateKey, String(Date.now()), {
			expirationTtl: TTL,
		});
		// A result webhook may have settled the turn while Slack accepted this edit.
		const latest = await readProgress(env, progress.key);
		if (!rendered.completed && latest?.completed) await update(latest);
	} catch (error) {
		if (error instanceof SlackRateLimitError)
			await env.THREADS.put(
				`activity-retry:${progress.key}`,
				String(Date.now() + error.retryAfterSeconds * 1000),
				{ expirationTtl: TTL },
			);
		console.warn("[slack-app] activity card unavailable", {
			code: error instanceof SlackApiError ? error.code : "unknown",
		});
		// Results are already persisted/delivered. Retry transient cleanup only;
		// a deleted card or revoked permission must not block the final response.
		if (
			progress.completed &&
			!(error instanceof SlackApiError && !error.retryable) &&
			!(
				error instanceof SlackApiError &&
				["message_not_found", "cant_update_message"].includes(error.code)
			)
		)
			throw error;
	}
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
	input: {
		key: string;
		channel: string;
		threadTs: string;
		messageTs?: string;
		details?: ProgressDetails;
	},
): Promise<TurnProgress> => {
	const existing = await readProgress(env, input.key);
	if (existing) return existing;
	const phase = "Preparing your request";
	await nativeStatus(env, input.channel, input.threadTs, phase);
	const messageTs = input.messageTs ?? input.threadTs;
	let workingReaction = "one_sec_cooking";
	const reaction = await env.setReaction(
		input.channel,
		messageTs,
		workingReaction,
		true,
	);
	if (reaction === "invalid_name") {
		workingReaction = "hourglass_flowing_sand";
		await env.setReaction(input.channel, messageTs, workingReaction, true);
	}
	const progress = {
		...input,
		messageTs,
		workingReaction,
		startedAt: Date.now(),
		phase,
	};
	await saveProgress(env, progress);
	await syncActivity(env, progress);
	return progress;
};

export const refreshStatus = async (
	env: RunnerEnv,
	key: string,
	phase: string,
	options: StatusRefresh = {},
): Promise<boolean> => {
	const progress = await readProgress(env, key);
	if (!progress) return false;
	if (progress.completed) await syncActivity(env, progress);
	const native = await nativeStatus(
		env,
		progress.channel,
		progress.threadTs,
		progress.completed || progress.waitingForUser ? "" : phase,
	);
	if (!progress.completed)
		await syncActivity(env, { ...progress, phase }, options);

	if (!progress.completed && (await readProgress(env, key))?.completed)
		await nativeStatus(env, progress.channel, progress.threadTs, "");
	if (progress.completed && progress.workingReaction)
		await env.setReaction(
			progress.channel,
			progress.messageTs ?? progress.threadTs,
			progress.workingReaction,
			false,
		);
	return native;
};

/** Preparation metadata is saved before submission; polling only renders activity. */
export const updateProgress = async (
	env: RunnerEnv,
	key: string,
	phase: string,
	options?: { details?: ProgressDetails; waitingForUser?: boolean },
): Promise<void> => {
	const progress = await readProgress(env, key);
	if (!progress || progress.completed) return;
	await saveProgress(env, {
		...progress,
		phase,
		waitingForUser: options?.waitingForUser ?? false,
		details: { ...progress.details, ...options?.details },
	});
	if (
		progress.workingReaction &&
		Boolean(options?.waitingForUser) !== Boolean(progress.waitingForUser)
	)
		await env.setReaction(
			progress.channel,
			progress.messageTs ?? progress.threadTs,
			progress.workingReaction,
			!options?.waitingForUser,
		);
	await refreshStatus(env, key, phase);
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
			text: `${outcome === "failed" ? ":warning:" : ":white_check_mark:"} ${outcome === "failed" ? "Needs attention" : "Done"}\n\n${text.length > 38000 ? `${text.slice(0, 38000)}\n_(Reply truncated; read the full result in Zuse.)_` : text}${progress.workspaceId ? `\n\n${workspaceLink(env, progress.workspaceId)}` : ""}`,
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
			phase: settled
				? outcome
				: "Status updates were interrupted. Work may still be running; open Zuse before retrying.",
			completed: settled,
			finishedAt: settled ? Date.now() : undefined,
		});
	}
	const latest = await readProgress(env, key);
	if (latest) await syncActivity(env, latest);
	await nativeStatus(env, progress.channel, progress.threadTs, "");
	if (progress.workingReaction)
		await env.setReaction(
			progress.channel,
			progress.messageTs ?? progress.threadTs,
			progress.workingReaction,
			false,
		);
	return true;
};
