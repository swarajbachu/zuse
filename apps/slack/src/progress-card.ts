import { escapeSlackText } from "./formatting.ts";
import type { TurnProgress } from "./progress.ts";
import type { RunnerEnv } from "./runner.ts";
import { workspaceLink, workspaceUrl } from "./workspace-link.ts";
import type { ZuseWorkspace } from "./zuse.ts";

export const workspaceProgressPhase = (
	workspace: ZuseWorkspace,
	queued: boolean,
): string => {
	const phases: Readonly<Record<string, string>> = {
		allocating: "Allocating the cloud workspace",
		booting: "Booting the cloud workspace",
		"authenticating-runtime": "Connecting to the workspace",
		"syncing-repository": "Preparing the repository",
		"starting-agent": "Starting the agent",
	};
	return (
		phases[workspace.startupPhase] ??
		(workspace.state !== "ready"
			? "Starting the cloud workspace"
			: queued
				? "Request queued in your workspace"
				: "Waiting for the agent’s result")
	);
};

/** Only facts supplied by the request, workspace, or completed context import. */
export interface ProgressDetails {
	readonly task?: string;
	readonly repository?: string;
	readonly branch?: string;
	readonly agent?: string;
	readonly model?: string;
	readonly historyMessages?: number;
	readonly attachments?: number;
	readonly contextLimited?: boolean;
	readonly followUp?: boolean;
}

const elapsed = (startedAt: number, now: number) => {
	const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
	return minutes < 1
		? "less than a minute"
		: minutes < 60
			? `${minutes}m`
			: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const progressCard = (
	env: Pick<RunnerEnv, "WORKSPACE_APP_ORIGIN" | "WORKSPACE_SCOPE">,
	progress: TurnProgress,
	checkedAt?: number,
) => {
	const details = progress.details;
	const title = progress.completed
		? progress.phase === "completed"
			? "Done"
			: "Needs attention"
		: progress.waitingForUser
			? "Needs your input"
			: progress.statusTs && !checkedAt
				? "Status unavailable"
				: "In progress";
	const phase = progress.completed
		? "The result is posted below."
		: progress.phase;
	const metadata = [details?.repository, details?.branch]
		.filter(Boolean)
		.join(" · ");
	const agent = [details?.agent, details?.model].filter(Boolean).join(" · ");
	const context =
		details?.historyMessages === undefined
			? undefined
			: [
					details.followUp
						? "Continuing this workspace’s existing conversation"
						: details.historyMessages > 0
							? `Included ${details.historyMessages} earlier thread message${details.historyMessages === 1 ? "" : "s"}`
							: "Included your request",
					`${details.attachments ?? 0} attachment${details.attachments === 1 ? "" : "s"} uploaded`,
				].join(" · ");
	const timing = [
		`Elapsed: ${elapsed(progress.startedAt, progress.finishedAt ?? Date.now())}`,
		...(checkedAt && !progress.completed
			? [
					`Status checked at ${new Date(checkedAt).toISOString().slice(11, 19)} UTC`,
				]
			: []),
	].join(" · ");
	const limited = details?.contextLimited
		? "Some earlier text or attachments were omitted because of context limits or unavailable file metadata."
		: undefined;
	const guidance = progress.completed
		? undefined
		: progress.waitingForUser
			? "Your request is saved. Complete the setup step to continue."
			: progress.workspaceId
				? "You can leave this thread; I’ll post the result here. Open Zuse to follow the full conversation."
				: "You can leave this thread; I’ll post the result here.";
	const task = details?.task?.slice(0, 500);
	const text = [
		`${title} — ${phase}`,
		task && escapeSlackText(task),
		metadata && escapeSlackText(metadata),
		agent && escapeSlackText(agent),
		context,
		limited,
		timing,
		guidance,
		progress.workspaceId && workspaceLink(env, progress.workspaceId),
	]
		.filter(Boolean)
		.join("\n");
	const blocks: Record<string, unknown>[] = [
		{
			type: "section",
			text: { type: "mrkdwn", text: `*${title}*\n${escapeSlackText(phase)}` },
		},
	];
	for (const value of [task, metadata, agent, context, limited])
		if (value)
			blocks.push({
				type: "section",
				text: { type: "plain_text", text: value.slice(0, 1500), emoji: false },
			});
	blocks.push({
		type: "context",
		elements: [{ type: "plain_text", text: timing }],
	});
	if (guidance)
		blocks.push({
			type: "context",
			elements: [{ type: "plain_text", text: guidance }],
		});
	if (progress.workspaceId)
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "view_workspace",
					text: { type: "plain_text", text: "View in Zuse" },
					url: workspaceUrl(env, progress.workspaceId),
				},
			],
		});
	return { text, blocks };
};
