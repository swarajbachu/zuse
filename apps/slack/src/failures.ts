import { executionAccount } from "./access.ts";
import { finishProgress } from "./progress.ts";
import { pendingRepository, repositoryLoadingView } from "./repositories.ts";
import { runnerEnv } from "./runner.ts";
import { postSlackMessage, slackApi } from "./slack.ts";
import { setThreadStatus } from "./thread-status.ts";
import type { AppEnv, AppJob } from "./types.ts";
import { ZuseApiError } from "./zuse.ts";

export const reportJobFailure = async (
	env: AppEnv,
	job: AppJob,
	error: unknown,
	permanent: boolean,
) => {
	const installation = await env.store.get(job.teamId);
	if (installation?.generation !== job.generation) return;
	const failure =
		error instanceof ZuseApiError &&
		error.message.includes("agent_and_model_required")
			? "Your Zuse account needs a cloud agent configured first. Open Zuse, start a cloud workspace and choose an agent and model, then send this request again. You do not need to enter internal IDs in Slack."
			: "I couldn’t complete this request. Check your Zuse account, repository access, and Slack permissions in App Home. If permissions changed, reinstall Zuse to authorize them. Any already-submitted work may still finish in Zuse.";
	if (job.kind === "picker") {
		await slackApi(installation.credentials.botToken, "views.update", {
			view_id: job.viewId,
			view: {
				...repositoryLoadingView(job.token),
				blocks: [
					{
						type: "section",
						text: {
							type: "plain_text",
							text: permanent
								? "Repositories could not be loaded. Check your Zuse account access, then close this window and click Select repository to retry."
								: "Repositories could not be loaded yet. Retrying automatically; you can also close this window and click Select repository again.",
						},
					},
				],
			},
		});
		return;
	}
	let work = job.kind === "agent-required" ? job.request : job;
	if (job.kind === "selection") {
		const selected = await pendingRepository(
			env,
			installation,
			job.token,
			job.userId,
		);
		if (!selected) return;
		work = selected.pending.job;
	}
	if (
		work.kind !== "conversation" &&
		work.kind !== "progress" &&
		work.kind !== "alert"
	)
		return;
	const active = await executionAccount(
		env,
		installation,
		work.kind === "alert"
			? installation.ownerId
			: (work.userId ?? installation.ownerId),
	);
	if (
		work.kind !== "alert" &&
		work.connectionId &&
		active?.connection.webhookId !== work.connectionId
	)
		return;
	const turnKey =
		work.kind === "progress"
			? work.turnKey
			: work.kind === "conversation"
				? `${work.channel}:${work.messageTs}`
				: undefined;
	const scoped = active
		? runnerEnv(env, installation, active.connection)
		: null;
	const updated =
		turnKey && scoped
			? await finishProgress(
					scoped,
					turnKey,
					failure,
					"failed",
					permanent || !(await scoped.THREADS.get(`submitted:${turnKey}`)),
				).catch(() => false)
			: false;
	if (!updated) {
		await setThreadStatus(env, installation, work.channel, work.threadTs, "");
		await postSlackMessage({
			botToken: installation.credentials.botToken,
			channel: work.channel,
			threadTs: work.threadTs,
			text: failure,
			idempotencyKey: `${job.teamId}:${job.generation}:failure:${job.id}`,
		});
	}
};
