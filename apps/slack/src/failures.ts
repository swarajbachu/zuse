import { executionAccount } from "./access.ts";
import { finishProgress, readProgress } from "./progress.ts";
import { pendingRepository, repositoryLoadingView } from "./repositories.ts";
import { runnerEnv } from "./runner.ts";
import { postSlackMessage, SlackApiError, slackApi } from "./slack.ts";
import { setThreadStatus } from "./thread-status.ts";
import { workspaceFailureText } from "./turn-errors.ts";
import type { AppEnv, AppJob } from "./types.ts";
import { getWorkspace, ZuseApiError } from "./zuse.ts";

export const reportJobFailure = async (
	env: AppEnv,
	job: AppJob,
	error: unknown,
	permanent: boolean,
) => {
	const installation = await env.store.get(job.teamId);
	if (installation?.generation !== job.generation) return;
	let failure =
		error instanceof ZuseApiError && error.code === "agent_not_available"
			? "The selected agent is no longer connected for this account or organization. Connect it in Zuse → Settings → Cloud Workspaces, or choose another connected agent in Slack Home, then send your request again."
			: error instanceof ZuseApiError &&
					error.message.includes("agent_and_model_required")
				? "Your Zuse account needs a cloud agent configured first. Open Zuse, start a cloud workspace and choose an agent and model, then send this request again. You do not need to enter internal IDs in Slack."
				: "I couldn’t confirm this request’s status. Any already-submitted work may still finish in Zuse. Open Zuse to check the conversation and retained work before sending the task again.";
	if (error instanceof SlackApiError) {
		if (error.code === "missing_scope")
			failure =
				"Zuse is missing a Slack permission needed for this request. Ask a workspace admin to reinstall Zuse to authorize its current permissions, then mention me again in this thread. Any already-submitted work may still finish in Zuse.";
		else if (
			["not_in_channel", "channel_not_found", "thread_not_found"].includes(
				error.code,
			)
		)
			failure =
				"I couldn’t access this Slack conversation. Invite Zuse to this channel and check that the thread is still available, then mention me again. Any already-submitted work may still finish in Zuse.";
		else if (
			["invalid_auth", "token_revoked", "account_inactive"].includes(error.code)
		)
			failure =
				"This Slack installation is no longer authorized. Ask a workspace admin to reconnect Zuse. Running work is not cancelled by a Slack disconnection.";
	}
	if (error instanceof ZuseApiError && [401, 403].includes(error.status))
		failure =
			"The connected Zuse account could not access this request. Check your account connection and repository access in Zuse’s App Home. Existing work stays in its original account; reconnecting does not transfer it.";
	if (
		error instanceof ZuseApiError &&
		error.retryable &&
		["workspace_read", "messages_read"].includes(error.operation)
	)
		failure =
			"I couldn’t retrieve the latest task status from Zuse. The agent may still be running. Open the workspace to review its conversation and retained work before retrying the task.";
	if (error instanceof ZuseApiError && error.code === "cloud_project_not_ready")
		failure =
			"Cloud setup is not ready for the selected repository. Open Zuse → Settings → Cloud Workspaces and resolve the reported setup or image error for this repository and machine provider. Then mention @Zuse again in this thread. This request has not started an agent.";
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
	// Cleanup retries must not turn an already-delivered answer into a failure notice.
	if (turnKey && scoped && (await readProgress(scoped, turnKey))?.completed)
		return;
	if (
		error instanceof ZuseApiError &&
		error.code === "workspace_not_accepting_messages"
	) {
		failure = workspaceFailureText();
		const progress =
			turnKey && scoped
				? await readProgress(scoped, turnKey).catch(() => null)
				: null;
		if (progress?.workspaceId && scoped) {
			const status = await getWorkspace(
				scoped.CLOUD,
				progress.workspaceId,
			).catch(() => null);
			if (status) failure = workspaceFailureText(status.workspace);
		}
	}
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
