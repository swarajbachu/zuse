import { executionAccount } from "./access.ts";
import { agentOptions, resolveAgentChoice } from "./agent-choice.ts";
import type { Installation } from "./installations.ts";
import { randomSecret } from "./installations.ts";
import { slackApi } from "./slack.ts";
import { setThreadStatus } from "./thread-status.ts";
import type { AppEnv, AppJob } from "./types.ts";
import { listProjects, type ZuseProject } from "./zuse.ts";

export const repositoryOptions = (projects: readonly ZuseProject[]) =>
	projects
		.filter((project) => project.state === "ready")
		.slice(0, 100)
		.map((project) => ({
			text: { type: "plain_text", text: project.displayName.slice(0, 75) },
			value: project.projectId,
		}));

type Conversation = Extract<AppJob, { kind: "conversation" }>;
interface PendingRepository {
	job: Conversation;
	connectionId: string;
	policyRevision: number;
	profileRevision: number;
	projectId?: string;
	needsAgent?: boolean;
	agentChoice?: string;
}
export const pendingRepository = async (
	env: AppEnv,
	installation: Installation,
	token: string,
	userId: string,
) => {
	if (!/^[a-f0-9]{64}$/u.test(token)) return null;
	const raw = await env.store.state(installation).get(`picker:${token}`);
	if (!raw) return null;
	const pending: PendingRepository = JSON.parse(raw);
	const active = await executionAccount(env, installation, userId);
	if (
		pending.job.userId !== userId ||
		pending.policyRevision !== installation.revision ||
		pending.connectionId !== active?.connection.webhookId
	)
		return null;
	return { pending, active };
};

export const promptRepository = async (
	env: AppEnv,
	installation: Installation,
	job: Conversation,
	connectionId: string,
	options: { announcement?: string; needsAgent?: boolean } = {},
) => {
	const { announcement, needsAgent = false } = options;
	if (job.revision !== installation.revision) return;
	const state = env.store.state(installation);
	const key = `picker-request:${job.channel}:${job.messageTs}`;
	const token = (await state.get(key)) ?? randomSecret();
	const active = await executionAccount(env, installation, job.userId);
	if (active?.connection.webhookId !== connectionId) return;
	const existing = await pendingRepository(
		env,
		installation,
		token,
		job.userId,
	);
	if (existing?.pending.needsAgent && !needsAgent) return;
	if (
		existing?.pending.projectId &&
		(!needsAgent || existing.pending.needsAgent)
	)
		return;
	await state.put(
		`picker:${token}`,
		JSON.stringify({
			job,
			connectionId,
			policyRevision: installation.revision,
			profileRevision: active.profile.revision,
			needsAgent,
		} satisfies PendingRepository),
		{ expirationTtl: 3600 },
	);
	await state.put(key, token, { expirationTtl: 3600 });
	await setThreadStatus(env, installation, job.channel, job.threadTs, "");
	await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
		channel: job.channel,
		user: job.userId,
		...(job.threadTs !== job.messageTs ? { thread_ts: job.threadTs } : {}),
		text: announcement ?? "Choose a repository to start this request.",
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text:
						announcement ??
						"*Which repository should I work on?*\nPick one to continue this request. You can save it as a default for next time.",
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: {
							type: "plain_text",
							text: needsAgent ? "Choose agent" : "Select repository",
						},
						action_id: "open_repository",
						value: token,
						style: "primary",
					},
				],
			},
		],
	});
};

export const repositoryLoadingView = (token: string) => ({
	type: "modal",
	callback_id: "select_repository",
	private_metadata: token,
	title: { type: "plain_text", text: "Configure request" },
	close: { type: "plain_text", text: "Cancel" },
	blocks: [
		{
			type: "section",
			text: {
				type: "plain_text",
				text: "Loading repository and agent options…",
			},
		},
	],
});

export const loadRepositoryView = async (
	env: AppEnv,
	installation: Installation,
	job: Extract<AppJob, { kind: "picker" }>,
) => {
	const selected = await pendingRepository(
		env,
		installation,
		job.token,
		job.userId,
	);
	if (!selected || selected.pending.projectId) {
		await slackApi(installation.credentials.botToken, "views.update", {
			view_id: job.viewId,
			view: {
				...repositoryLoadingView(job.token),
				blocks: [
					{
						type: "section",
						text: {
							type: "plain_text",
							text: "This request expired or your account changed. Close this window and send your task again.",
						},
					},
				],
			},
		});
		return;
	}
	const { projects } = await listProjects(
		env.cloud(selected.active.connection.accountId),
	);
	const options = repositoryOptions(projects);
	const initialProject = options.find(
		(option) => option.value === selected.pending.job.projectId,
	);
	const agents = agentOptions();
	const connection = selected.active.connection;
	const initialAgent = agents.find(
		(option) => option.value === `${connection.agent}:${connection.model}`,
	);
	const blocks: Record<string, unknown>[] = options.length
		? [
				{
					type: "input",
					block_id: "repository",
					label: { type: "plain_text", text: "Repository" },
					element: {
						type: "static_select",
						action_id: "project",
						placeholder: { type: "plain_text", text: "Search repositories…" },
						options,
						...(initialProject ? { initial_option: initialProject } : {}),
					},
				},
				{
					type: "input",
					optional: !selected.pending.needsAgent,
					block_id: "agent",
					label: { type: "plain_text", text: "Agent and model" },
					element: {
						type: "static_select",
						action_id: "choice",
						placeholder: {
							type: "plain_text",
							text: "Choose an agent and model…",
						},
						options: agents,
						...(initialAgent ? { initial_option: initialAgent } : {}),
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "plain_text",
							text:
								"Uses your connected account’s cloud credentials and usage. Choosing an agent does not connect its provider account." +
								(selected.pending.needsAgent
									? " Choose an agent and model to continue."
									: " Leave blank to use your account’s existing agent default."),
						},
					],
				},
				...(selected.active.ownerId === job.userId
					? [
							{
								type: "input",
								optional: true,
								block_id: "defaults",
								label: { type: "plain_text", text: "Remember repository" },
								element: {
									type: "checkboxes",
									action_id: "remember",
									options: [
										{
											text: {
												type: "plain_text",
												text: "Set as default for this channel",
											},
											value: "channel",
										},
										{
											text: {
												type: "plain_text",
												text: "Set as my default repository",
											},
											value: "personal",
										},
									],
								},
							},
						]
					: []),
				{
					type: "context",
					elements: [
						{
							type: "plain_text",
							text:
								selected.active.ownerId === job.userId
									? "Defaults belong to your connected account. Existing threads keep their repository."
									: "Using the team’s shared account. Only its owner can change shared defaults.",
						},
					],
				},
			]
		: [
				{
					type: "section",
					text: {
						type: "plain_text",
						text: "No ready repositories yet. Prepare a cloud project in Zuse, then send your request again.",
					},
				},
			];
	await slackApi(installation.credentials.botToken, "views.update", {
		view_id: job.viewId,
		view: {
			...repositoryLoadingView(job.token),
			blocks,
			...(options.length
				? { submit: { type: "plain_text", text: "Start request" } }
				: {}),
		},
	});
};

export const acceptRepository = async (
	env: AppEnv,
	installation: Installation,
	job: Extract<AppJob, { kind: "selection" }>,
): Promise<Conversation | null> => {
	const selected = await pendingRepository(
		env,
		installation,
		job.token,
		job.userId,
	);
	if (!selected) return null;
	const { pending, active } = selected;
	const agentSelection = resolveAgentChoice(job.agentChoice);
	if ((pending.needsAgent || job.agentChoice !== undefined) && !agentSelection)
		return null;
	if (pending.projectId && pending.agentChoice !== job.agentChoice) return null;
	// Queue consumers are serialized. The first accepted choice is immutable on redelivery.
	if (pending.projectId && pending.projectId !== job.projectId) return null;
	if (
		(await env.store
			.state(installation)
			.get(`conversation:${pending.job.channel}:${pending.job.messageTs}`)) ===
		"1"
	)
		return null;
	const { projects } = await listProjects(
		env.cloud(active.connection.accountId),
	);
	if (
		!projects.some((p) => p.projectId === job.projectId && p.state === "ready")
	) {
		await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
			channel: pending.job.channel,
			user: job.userId,
			text: "That repository is no longer available to the connected account. Please send your task again and choose another.",
		});
		return null;
	}
	await env.store.state(installation).put(
		`picker:${job.token}`,
		JSON.stringify({
			...pending,
			projectId: job.projectId,
			agentChoice: job.agentChoice,
		}),
		{ expirationTtl: 3600 },
	);
	if (
		(job.channelDefault || job.personalDefault) &&
		active.ownerId === job.userId &&
		active.profile.revision === pending.profileRevision
	) {
		if (
			!(await env.store.saveMember(installation, active.ownerId, {
				...active.profile,
				defaults: {
					...active.profile.defaults,
					...(job.personalDefault ? { projectId: job.projectId } : {}),
					channels: {
						...active.profile.defaults.channels,
						...(job.channelDefault
							? { [pending.job.channel]: job.projectId }
							: {}),
					},
				},
			}))
		)
			throw new Error("slack_defaults_changed");
	}
	return {
		...pending.job,
		...(agentSelection ? { agentSelection } : {}),
		projectId: job.projectId,
		selectionToken: job.token,
	};
};
