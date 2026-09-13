import { executionAccount, policyOptions } from "./access.ts";
import { connectUrl } from "./accounts.ts";
import type { Installation } from "./installations.ts";
import { repositoryOptions } from "./repositories.ts";
import { slackApi } from "./slack.ts";
import type { AppEnv } from "./types.ts";
import { appOrigin } from "./web.ts";
import { deleteWebhook, listProjects } from "./zuse.ts";

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

export const publishHome = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
): Promise<void> => {
	const mine = await env.store.member(installation, userId);
	const active = await executionAccount(env, installation, userId);
	const isInstaller = userId === installation.ownerId;
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
	if (active) {
		const catalog = await listProjects(
			env.cloud(active.connection.accountId),
		).catch(() => null);
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
		if (active.ownerId !== userId)
			blocks.push({
				type: "section",
				text: {
					type: "plain_text",
					text: "This workspace uses the installer's shared Zuse account for tasks. Repository access and cloud usage belong to that account.",
				},
			});
	}
	if (isInstaller) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Who can run tasks?*\nSharing grants the team access to the connected account’s cloud repositories and usage. Only enable it for a trusted team.",
			},
			accessory: {
				type: "static_select",
				action_id: "access_mode",
				options: policyOptions,
				initial_option: policyOptions.find(
					(option) =>
						option.value ===
						(installation.credentials.accessMode ?? "installer"),
				),
				confirm: {
					title: { type: "plain_text", text: "Change account access?" },
					text: {
						type: "mrkdwn",
						text: "The whole-team option lets other Slack members run tasks and see results using your account’s repository access and cloud usage. Other options do not share your credentials.",
					},
					confirm: { type: "plain_text", text: "Confirm access" },
					deny: { type: "plain_text", text: "Cancel" },
				},
			},
		});
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
		env.cloud(active.connection.accountId),
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
			env.cloud(profile.connection.accountId),
			connectionId,
		).catch(() => console.error("[slack-app] remote webhook cleanup failed"));
		if (options.notify !== false) await publishHome(env, installation, userId);
	}
};
