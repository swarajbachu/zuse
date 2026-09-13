import { executionAccount } from "./access.ts";
import { promptConnection } from "./accounts.ts";
import type { Installation } from "./installations.ts";
import {
	attachWorkspace,
	finishProgress,
	readProgress,
	refreshStatus,
	startProgress,
	updateProgress,
} from "./progress.ts";
import { pendingRepository, promptRepository } from "./repositories.ts";
import {
	runnerEnv,
	saveThreadMapping,
	slackThreadPrompt,
	uploadSlackFiles,
} from "./runner.ts";
import {
	parseSlackFiles,
	postSlackMessage,
	readSlackThread,
	slackApi,
} from "./slack.ts";
import { setThreadStatus } from "./thread-status.ts";
import type { AppEnv, AppJob } from "./types.ts";
import {
	createWorkspace,
	getWorkspace,
	listProjects,
	readTurn,
	sendMessage,
	ZuseApiError,
} from "./zuse.ts";

type ConversationJob = Extract<AppJob, { kind: "conversation" }>;
const TTL = 30 * 86400;
export const conversationText = (text: string, botUserId: string): string =>
	text.replaceAll(`<@${botUserId}>`, "").trim();
export const isConversationEvent = (
	event: {
		type?: string;
		channel?: string;
		thread_ts?: string;
		text?: string;
		bot_id?: string | null;
		subtype?: string;
		user?: string;
	},
	botUserId: string,
): boolean =>
	Boolean(
		event.user &&
			event.user !== botUserId &&
			!event.bot_id &&
			(!event.subtype || event.subtype === "file_share") &&
			(event.type === "app_mention" ||
				(event.type === "message" &&
					((event.channel?.startsWith("D") && !event.thread_ts) ||
						event.text?.includes(`<@${botUserId}>`)))),
	);

export const runConversation = async (
	env: AppEnv,
	installation: Installation,
	job: ConversationJob,
): Promise<void> => {
	const state = env.store.state(installation);
	const dedupe = `conversation:${job.channel}:${job.messageTs}`;
	const receipt = await state.get(dedupe);
	if (receipt === "1" || (receipt && !job.selectionToken)) return;
	const reply = async (text: string) => {
		await postSlackMessage({
			botToken: installation.credentials.botToken,
			channel: job.channel,
			threadTs: job.threadTs,
			text,
			idempotencyKey: `${installation.teamId}:${installation.generation}:${dedupe}`,
		});
		await state.put(dedupe, "1", { expirationTtl: TTL });
	};
	const home = `slack://app?team=${installation.teamId}&id=${env.SLACK_APP_ID}&tab=home`;
	const activeAccount = await executionAccount(env, installation, job.userId);
	if (!activeAccount) {
		if (
			(installation.credentials.accessMode ?? "installer") === "installer" &&
			job.userId !== installation.ownerId
		) {
			await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
				channel: job.channel,
				user: job.userId,
				text: "This workspace is set to installer-only. Ask the installer to choose individual accounts or explicitly enable team sharing in Zuse’s Home tab.",
			});
		} else if (
			installation.credentials.accessMode === "shared" &&
			job.userId !== installation.ownerId
		) {
			await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
				channel: job.channel,
				user: job.userId,
				text: "The team’s shared account is disconnected. Ask the installer to reconnect it or enable individual accounts.",
			});
		} else {
			await promptConnection(
				env,
				installation,
				job.userId,
				job.channel,
				job.connectionId ? undefined : job,
			);
			await state.put(dedupe, "awaiting-account", { expirationTtl: 3600 });
			return;
		}
		await state.put(dedupe, "1", { expirationTtl: 600 });
		return;
	}
	const { connection, profile } = activeAccount;
	if (job.connectionId && job.connectionId !== connection.webhookId) {
		await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
			channel: job.channel,
			user: job.userId,
			text: "Your connected account changed. Please send your request again.",
		});
		return;
	}
	if (job.selectionToken) {
		const selected = await pendingRepository(
			env,
			installation,
			job.selectionToken,
			job.userId,
		);
		if (
			!selected ||
			selected.pending.projectId !== job.projectId ||
			(selected.pending.needsAgent && !job.agentSelection) ||
			selected.pending.job.messageTs !== job.messageTs
		)
			return;
	}
	if (job.revision !== installation.revision) {
		await reply(
			"Your connection or settings changed while this request was queued. Please send the task again with the current settings.",
		);
		return;
	}
	const text = conversationText(job.text, installation.credentials.botUserId);
	if (text.length > 40_000) {
		await reply(
			"This request is too long. Please send a task under 40,000 characters and attach supporting files separately.",
		);
		return;
	}
	if (parseSlackFiles(job.files).length !== (job.files?.length ?? 0)) {
		await reply(
			"I couldn’t read the metadata for an attachment. Please re-upload it in this thread with your task; I haven’t started an agent or inspected that file.",
		);
		return;
	}
	if (!text || /^(?:help|what can you do)[!?.\s]*$/iu.test(text)) {
		await reply(
			`Hi! Mention me with a task, or send me a DM. When you bring me into an existing thread, I’ll read its context and supported images, work in your selected repository, and return the result here.\n\n<${home}|Choose your repository and manage your connection>\nExample: “@Zuse investigate this error and add a regression test.” Mention me in the same thread to continue, or enable untagged follow-ups in Home.`,
		);
		return;
	}
	const scoped = runnerEnv(env, installation, connection);
	const key = `${job.channel}:${job.messageTs}`;
	const activeKey = `active:${job.channel}:${job.threadTs}`;
	const active = await scoped.THREADS.get(activeKey);
	if (
		active &&
		active !== key &&
		!(await readProgress(scoped, active))?.completed
	) {
		await reply(
			"I’m still working on the previous request in this thread. Please wait for its result, then mention me with your follow-up. Start a new thread for a separate task.",
		);
		return;
	}
	const config = {
		...scoped.CLOUD,
		workspaceDefaults: job.agentSelection ?? {
			agent: connection.agent,
			model: connection.model,
		},
	};
	await setThreadStatus(
		env,
		installation,
		job.channel,
		job.threadTs,
		"Zusing…",
	);
	let workspaceId = await scoped.THREADS.get(
		`thread:${job.channel}:${job.threadTs}`,
	);
	const projectId =
		job.projectId ??
		profile.defaults.channels[job.channel] ??
		profile.defaults.projectId ??
		connection.projectId;
	if (!workspaceId) {
		const { projects } = await listProjects(config);
		const ready = projects.filter((p) => p.state === "ready");
		if (!projectId || !ready.some((p) => p.projectId === projectId)) {
			await promptRepository(env, installation, job, connection.webhookId);
			await state.put(dedupe, "waiting", { expirationTtl: 3600 });
			return;
		}
	}
	const progress = await startProgress(scoped, {
		key,
		channel: job.channel,
		threadTs: job.threadTs,
	});
	if (progress.completed) {
		await refreshStatus(scoped, key, "");
		await state.put(dedupe, "1", { expirationTtl: TTL });
		return;
	}
	await scoped.THREADS.put(activeKey, key, { expirationTtl: TTL });
	const imported = await scoped.THREADS.get(`submitted:${key}`);
	if (!imported) {
		const cached = await scoped.THREADS.get(`context:${key}`);
		// Only import history when first invited into an existing conversation.
		// Keep the cached decision across retries, even after workspace creation.
		const importHistory = !workspaceId && job.threadTs !== job.messageTs;
		await updateProgress(
			scoped,
			key,
			importHistory
				? "Reading thread context and attachments"
				: "Preparing your request and attachments",
		);
		const thread = cached
			? (JSON.parse(cached) as Awaited<ReturnType<typeof readSlackThread>>)
			: importHistory
				? await readSlackThread({
						token: scoped.SLACK_BOT_TOKEN,
						channel: job.channel,
						threadTs: job.threadTs,
						latestTs: job.messageTs,
						checkpoint: {
							load: () => scoped.THREADS.get(`pages:${key}`),
							save: (value) =>
								scoped.THREADS.put(`pages:${key}`, value, {
									expirationTtl: 86400,
								}),
						},
					})
				: [];
		if (!cached)
			await scoped.THREADS.put(`context:${key}`, JSON.stringify(thread), {
				expirationTtl: 86400,
			});
		const history = thread.filter(
			(m) =>
				m.ts !== job.messageTs && m.user !== installation.credentials.botUserId,
		);
		await updateProgress(
			scoped,
			key,
			workspaceId
				? "Preparing your follow-up"
				: "Preparing your repository and workspace",
		);
		if (!workspaceId) {
			let created: Awaited<ReturnType<typeof createWorkspace>>;
			try {
				created = await createWorkspace(
					{
						...config,
						workspaceDefaults: { ...config.workspaceDefaults, projectId },
					},
					{
						idempotencyKey: `${scoped.NAMESPACE}:conversation:${job.channel}:${job.threadTs}`,
					},
				);
			} catch (error) {
				if (
					!(error instanceof ZuseApiError) ||
					error.status !== 400 ||
					!error.message.includes("agent_and_model_required") ||
					job.agentSelection
				)
					throw error;
				await updateProgress(
					scoped,
					key,
					"Waiting for you to choose an agent in the private Slack picker",
				);
				await env.JOBS.send({
					kind: "agent-required",
					teamId: installation.teamId,
					generation: installation.generation,
					id: `agent-required:${job.channel}:${job.messageTs}`,
					request: { ...job, projectId, connectionId: connection.webhookId },
				});
				await state.put(dedupe, "waiting", { expirationTtl: 3600 });
				await scoped.THREADS.put(activeKey, "", { expirationTtl: TTL });
				return;
			}
			workspaceId = created.workspace.workspaceId;
			await saveThreadMapping(scoped, workspaceId, job.channel, job.threadTs);
		}
		await scoped.THREADS.put(`workspace-turn:${workspaceId}`, key, {
			expirationTtl: TTL,
		});
		await attachWorkspace(scoped, key, workspaceId);
		const files = [
			...new Map(
				[...history.flatMap((m) => m.files), ...parseSlackFiles(job.files)].map(
					(file) => [file.id, file],
				),
			).values(),
		];
		const attachments = await uploadSlackFiles(
			scoped,
			workspaceId,
			files,
			`${scoped.NAMESPACE}:conversation:${key}`,
		);
		// Save progress before submission: a very fast completed webhook must never be overwritten.
		await updateProgress(
			scoped,
			key,
			"Working on your request; the result will appear here",
		);
		const message = await sendMessage(config, {
			workspaceId,
			text: [
				`Request from Slack (thread ${job.threadTs}):\n${text}`,
				history.length ? slackThreadPrompt(history, 63_000 - text.length) : "",
			]
				.filter(Boolean)
				.join("\n\n"),
			attachments,
			idempotencyKey: `${scoped.NAMESPACE}:conversation-message:${key}`,
		});
		await scoped.THREADS.put(
			`submitted-seq:${key}`,
			String(Math.max(0, message.seq - 1)),
			{ expirationTtl: TTL },
		);
		await scoped.THREADS.put(`submitted:${key}`, message.messageId, {
			expirationTtl: TTL,
		});
	}
	if (!workspaceId) throw new Error("slack_workspace_mapping_missing");
	await env.JOBS.send(
		{
			kind: "progress",
			teamId: job.teamId,
			generation: job.generation,
			id: `progress:${key}:0`,
			channel: job.channel,
			threadTs: job.threadTs,
			workspaceId,
			turnKey: key,
			connectionId: connection.webhookId,
			startedAt: progress.startedAt,
			userId: job.userId,
		},
		{ delaySeconds: 30 },
	);
	await state.put(dedupe, "1", { expirationTtl: TTL });
};

export const pollProgress = async (
	env: AppEnv,
	installation: Installation,
	job: Extract<AppJob, { kind: "progress" }>,
): Promise<void> => {
	const active = await executionAccount(
		env,
		installation,
		job.userId ?? installation.ownerId,
	);
	if (active?.connection.webhookId !== job.connectionId) return;
	const scoped = runnerEnv(env, installation, active.connection);
	const progress = await readProgress(scoped, job.turnKey);
	if (!progress) return;
	if (
		(await scoped.THREADS.get(`workspace-turn:${job.workspaceId}`)) !==
		job.turnKey
	)
		return;
	if (progress.completed) {
		await refreshStatus(scoped, job.turnKey, "");
		return;
	}
	const { workspace } = await getWorkspace(scoped.CLOUD, job.workspaceId);
	const messageId = await scoped.THREADS.get(`submitted:${job.turnKey}`);
	if (messageId) {
		const { result, requestStatus } = await readTurn(
			scoped.CLOUD,
			job.workspaceId,
			messageId,
			Number((await scoped.THREADS.get(`submitted-seq:${job.turnKey}`)) ?? "0"),
		);
		if (result) {
			await finishProgress(
				scoped,
				job.turnKey,
				result.text || `The turn settled (${result.outcome}).`,
				result.outcome === "completed" ? "completed" : "failed",
			);
			return;
		}
		if (requestStatus === "expired" || requestStatus === "failed") {
			await finishProgress(
				scoped,
				job.turnKey,
				`The queued request ${requestStatus} before completion. Open the workspace in Zuse to check its agent connection, then send your task again.`,
				"failed",
			);
			return;
		}
	}
	if (["failed", "deleted", "archived"].includes(workspace.state)) {
		await finishProgress(
			scoped,
			job.turnKey,
			`Workspace is ${workspace.state}. Check the workspace in Zuse before retrying.`,
			"failed",
		);
		return;
	}
	// Keep recovery polling for long turns, but reduce load after the first hour.
	const delaySeconds = Date.now() - job.startedAt > 60 * 60 * 1000 ? 300 : 30;
	const phase =
		workspace.agentStatus === "working"
			? "Working on your request"
			: workspace.state === "ready"
				? "Waiting for the agent’s result"
				: "Starting the cloud workspace";
	await refreshStatus(scoped, job.turnKey, phase);
	await env.JOBS.send(
		{ ...job, id: `progress:${job.turnKey}:${Math.floor(Date.now() / 30000)}` },
		{ delaySeconds },
	);
};
