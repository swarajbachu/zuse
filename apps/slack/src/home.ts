import { executionAccount, policyOptions } from "./access.ts";
import { connectUrl } from "./accounts.ts";
import {
	agentSettingOptions,
	defaultAgentModel,
	modelSettingOptions,
} from "./agent-choice.ts";
import type { Installation } from "./installations.ts";
import { repositoryOptions } from "./repositories.ts";
import { slackApi } from "./slack.ts";
import type { AppEnv } from "./types.ts";
import { appOrigin } from "./web.ts";
import {
	deleteWebhook,
	listAgents,
	listProjects,
	listProviders,
} from "./zuse.ts";

const replyOptions = [
	{
		text: { type: "plain_text", text: "Only when I @mention Zuse" },
		value: "mentions",
	},
	{
		text: { type: "plain_text", text: "All my replies in active threads" },
		value: "all",
	},
];

export const selectReplyMode = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	mode: "mentions" | "all",
	revision: number,
) => {
	const mine = await env.store.member(installation, userId);
	if (mine.revision === revision)
		await env.store.saveMember(installation, userId, {
			...mine,
			defaults: { ...mine.defaults, replyMode: mode },
		});
	await publishHome(env, installation, userId);
};

export const selectExecutionDefault = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	field: "agent" | "model" | "providerId",
	value: string,
	revision: number,
	memberRevision: number,
) => {
	const active = await executionAccount(env, installation, userId);
	if (
		!active ||
		active.ownerId !== userId ||
		installation.revision !== revision ||
		active.profile.revision !== memberRevision
	)
		return publishHome(env, installation, userId);
	let connection = active.connection;
	const available =
		field === "providerId"
			? undefined
			: (
					await listAgents(
						env.cloud(
							active.connection.accountId,
							active.connection.organizationId,
						),
					)
				).agents;
	if (field === "agent") {
		if (value === "__default")
			connection = { ...connection, agent: undefined, model: undefined };
		else if (
			agentSettingOptions(available).some((option) => option.value === value)
		)
			connection = {
				...connection,
				agent: value,
				model: defaultAgentModel(value),
			};
		else return publishHome(env, installation, userId);
	} else if (field === "model") {
		if (
			!connection.agent ||
			!available?.includes(connection.agent) ||
			!modelSettingOptions(connection.agent).some(
				(option) => option.value === value,
			)
		)
			return publishHome(env, installation, userId);
		connection = { ...connection, model: value };
	} else {
		if (value !== "__default") {
			const { providers } = await listProviders(
				env.cloud(connection.accountId, connection.organizationId),
			);
			if (!providers.some((provider) => provider.providerId === value))
				return publishHome(env, installation, userId);
		}
		connection = {
			...connection,
			providerId: value === "__default" ? undefined : value,
		};
	}
	await env.store.saveMember(installation, userId, {
		...active.profile,
		connection,
	});
	await publishHome(env, installation, userId);
};

export const publishHome = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
): Promise<void> => {
	const mine = await env.store.member(installation, userId);
	const active = await executionAccount(env, installation, userId);
	const isInstaller = userId === installation.ownerId;
	const cloud = active
		? env.cloud(active.connection.accountId, active.connection.organizationId)
		: undefined;
	const agentsPromise = cloud
		? listAgents(cloud).catch(() => null)
		: Promise.resolve(null);
	const providersPromise =
		cloud && active?.ownerId === userId
			? listProviders(cloud).catch(() => null)
			: Promise.resolve(null);
	const blocks: Record<string, unknown>[] = [
		{ type: "header", text: { type: "plain_text", text: "Zuse for Slack" } },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "Your coding workspace, right here. Mention *Zuse* or send a DM, choose a repository, and follow the work through to its result.",
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: mine.connection
					? "*Your account is connected*\nYour connection and settings on this page are only visible to you."
					: "*Connect your Zuse account*\nSign in once. No API key, agent ID, or model ID needed.",
			},
		},
		{
			type: "actions",
			elements: [
				mine.connection
					? {
							type: "button",
							text: { type: "plain_text", text: "Disconnect my account" },
							action_id: "disconnect_account",
							value: mine.connection.webhookId,
							confirm: {
								title: { type: "plain_text", text: "Disconnect Zuse?" },
								text: {
									type: "mrkdwn",
									text: "New requests will no longer use this account. Already-running work is not cancelled.",
								},
								confirm: { type: "plain_text", text: "Disconnect" },
								deny: { type: "plain_text", text: "Keep connected" },
							},
						}
					: {
							type: "button",
							text: { type: "plain_text", text: "Connect Zuse account" },
							style: "primary",
							action_id: "connect_account",
							url: await connectUrl(env, installation, userId),
						},
			],
		},
	];
	if (mine.connection)
		blocks.push({
			type: "context",
			elements: [
				{
					type: "plain_text",
					text: `Organization: ${mine.connection.organizationName ?? "Personal"}`,
				},
			],
		});
	blocks.push({
		type: "section",
		text: {
			type: "mrkdwn",
			text: "*My follow-up replies*\nBy default, @mention Zuse for each task, including in DMs. Optionally let your untagged replies continue an existing Zuse workspace. This changes only your replies, not teammates’ messages. New DMs can always start a task.",
		},
		accessory: {
			type: "static_select",
			action_id: "reply_mode",
			options: replyOptions,
			initial_option: replyOptions.find(
				(option) => option.value === (mine.defaults.replyMode ?? "mentions"),
			),
		},
	});
	if (active && cloud) {
		const catalog = await listProjects(cloud).catch(() => null);
		if (!catalog)
			blocks.push({
				type: "section",
				text: {
					type: "plain_text",
					text: "Repositories are temporarily unavailable. Reopen Home to retry; you can still manage your account above.",
				},
			});
		else {
			const options = repositoryOptions(catalog.projects);
			const selected = options.find(
				(option) => option.value === active.profile.defaults.projectId,
			);
			if (options.length && active.ownerId === userId)
				blocks.push({
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Default repository*\nChange this before starting a new thread. Saved channel defaults take precedence; existing threads keep their workspace.",
					},
					accessory: {
						type: "static_select",
						action_id: "select_project",
						placeholder: {
							type: "plain_text",
							text: "Choose a default repository",
						},
						options,
						...(selected ? { initial_option: selected } : {}),
					},
				});
			else if (!options.length)
				blocks.push({
					type: "section",
					text: {
						type: "plain_text",
						text: "Prepare a cloud repository in Zuse first, then reopen Home. Your account connection is already saved.",
					},
				});
		}
	}
	if (active && active.ownerId === userId) {
		const accountDefault = {
			value: "__default",
			text: { type: "plain_text", text: "Use account default" },
		};
		const agents = [
			{
				...accountDefault,
				text: { type: "plain_text", text: "Choose when starting a task" },
			},
			...agentSettingOptions((await agentsPromise)?.agents ?? []),
		];
		const availability = await agentsPromise;
		const models =
			active.connection.agent &&
			availability?.agents.includes(active.connection.agent)
				? modelSettingOptions(active.connection.agent)
				: [];
		const control = (
			label: string,
			action: string,
			options: typeof agents,
			selected?: string,
		) => ({
			type: "section",
			text: { type: "mrkdwn", text: `*${label}*` },
			accessory: {
				type: "static_select",
				action_id: action,
				options,
				placeholder: {
					type: "plain_text",
					text: `Choose ${label.toLowerCase()}`,
				},
				...(options.find((option) => option.value === selected)
					? {
							initial_option: options.find(
								(option) => option.value === selected,
							),
						}
					: {}),
			},
		});
		blocks.push({
			type: "section",
			text: {
				type: "plain_text",
				text: "Task defaults for this Slack connection. These apply to new workspaces and alert automations; existing threads keep their workspace. Agent credentials must be connected in Zuse.",
			},
		});
		if (
			!availability ||
			availability.agents.length === 0 ||
			(active.connection.agent &&
				!availability.agents.includes(active.connection.agent))
		)
			blocks.push({
				type: "section",
				text: {
					type: "plain_text",
					text: !availability
						? "Agent availability could not be checked. Reopen Home to retry."
						: "Connect an agent in Zuse → Settings → Cloud Workspaces for this account or organization. Only connected agents can start new requests.",
				},
			});
		blocks.push(
			control(
				"Agent",
				"default_agent",
				agents,
				active.connection.agent ?? "__default",
			),
		);
		if (models.length)
			blocks.push(
				control("Model", "default_model", models, active.connection.model),
			);
		const catalog = await providersPromise;
		if (catalog?.providers) {
			const options = [
				accountDefault,
				...catalog.providers
					.filter((provider) => provider.providerId.length <= 150)
					.slice(0, 99)
					.map((provider) => ({
						value: provider.providerId,
						text: {
							type: "plain_text",
							text: provider.displayName.slice(0, 75),
						},
					})),
			];
			blocks.push(
				control(
					"Sandbox provider",
					"default_provider",
					options,
					active.connection.providerId ?? "__default",
				),
			);
			if (
				active.connection.providerId &&
				!options.some((option) => option.value === active.connection.providerId)
			)
				blocks.push({
					type: "context",
					elements: [
						{
							type: "plain_text",
							text: "Your saved sandbox provider is unavailable. Select another provider before starting a new task.",
						},
					],
				});
		} else
			blocks.push({
				type: "context",
				elements: [
					{
						type: "plain_text",
						text: "Sandbox providers are temporarily unavailable. Reopen Home to retry.",
					},
				],
			});
	}
	const selectedPolicy = policyOptions.find(
		(option) =>
			option.value === (installation.credentials.accessMode ?? "installer"),
	);
	blocks.push({
		type: "section",
		text: {
			type: "mrkdwn",
			text: `*Workspace task access*\nOne setting for this entire Slack workspace, managed by <@${installation.ownerId}>, who installed Zuse. It applies to everyone; members do not choose separate modes.\n*Current mode:* ${selectedPolicy?.text.text}`,
		},
		...(isInstaller
			? {
					accessory: {
						type: "static_select",
						action_id: "access_mode",
						options: policyOptions,
						initial_option: selectedPolicy,
						confirm: {
							title: {
								type: "plain_text",
								text: "Change workspace task access?",
							},
							text: {
								type: "mrkdwn",
								text: "This changes task access for everyone in this Slack workspace. Sharing your account lets everyone use its repositories, selected organization, and cloud usage. Enable sharing only for a trusted team.",
							},
							confirm: { type: "plain_text", text: "Change for everyone" },
							deny: { type: "plain_text", text: "Cancel" },
						},
					},
				}
			: {}),
	});
	if (isInstaller) {
		const token = await env.store.session("login", installation);
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `<${appOrigin(env)}/slack/setup/login?token=${token}|Manage alert automations>`,
			},
		});
	}
	await slackApi(installation.credentials.botToken, "views.publish", {
		user_id: userId,
		view: {
			type: "home",
			private_metadata: JSON.stringify({
				revision: installation.revision,
				memberRevision: mine.revision,
			}),
			blocks,
		},
	});
};

export const selectProject = async (
	env: AppEnv,
	installation: Installation,
	projectId: string,
	userId: string,
	revision: number,
	memberRevision?: number,
) => {
	const active = await executionAccount(env, installation, userId);
	if (
		!active ||
		active.ownerId !== userId ||
		installation.revision !== revision ||
		(memberRevision !== undefined && active.profile.revision !== memberRevision)
	)
		return publishHome(env, installation, userId);
	const { projects } = await listProjects(
		env.cloud(active.connection.accountId, active.connection.organizationId),
	);
	if (projects.some((p) => p.projectId === projectId && p.state === "ready"))
		await env.store.saveMember(installation, userId, {
			...active.profile,
			defaults: { ...active.profile.defaults, projectId },
		});
	await publishHome(env, installation, userId);
};

export const disconnectMember = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	connectionId: string,
	options: { notify?: boolean } = {},
) => {
	const profile = await env.store.member(installation, userId);
	if (profile.connection?.webhookId !== connectionId) return;
	if (
		await env.store.saveMember(installation, userId, {
			...profile,
			connection: null,
			defaults: { channels: {} },
		})
	) {
		// Local revocation is authoritative, even if the remote subscription is unavailable.
		await deleteWebhook(
			env.cloud(
				profile.connection.accountId,
				profile.connection.organizationId,
			),
			connectionId,
		).catch(() => console.error("[slack-app] remote webhook cleanup failed"));
		if (options.notify !== false) await publishHome(env, installation, userId);
	}
};
