import { agentSettingOptions } from "./agent-choice.ts";
import { markdownToSlack } from "./formatting.ts";
import type { ZuseTurnFailure, ZuseWorkspace } from "./zuse.ts";

const plainSlackText = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const workspaceFailureText = (
	workspace?: Pick<ZuseWorkspace, "state" | "statusCode">,
): string => {
	if (workspace?.statusCode === "provider-unavailable")
		return "The cloud provider is unavailable for this workspace. Open the workspace in Zuse and resume it when the provider is available, then send your request again.";
	if (
		["archiving", "archived", "deleting", "deleted"].includes(
			workspace?.state ?? "",
		)
	)
		return "This thread’s cloud workspace has been archived or deleted and cannot accept new requests. Start a new Slack thread for a new workspace.";
	return "This thread’s cloud workspace cannot accept requests. Open the workspace in Zuse to resolve its error and resume it, then send your request again.";
};

export const turnFailureText = (failure: ZuseTurnFailure): string => {
	const agent =
		agentSettingOptions().find((option) => option.value === failure.agent)?.text
			.text ?? "The selected agent";
	if (failure.code === "agent_not_installed")
		return `${agent} isn’t installed in this cloud workspace. Choose another agent and model in Zuse’s Slack Home, then start a new thread. This thread keeps its existing workspace.`;
	if (failure.message.trim() === `${failure.agent}-auth-reconnect-required`)
		return `Reconnect ${agent} in Zuse → Settings → Cloud Workspaces for the account or organization selected in Slack Home, then send your request again. Selecting an agent in Slack does not sign in to its provider.`;
	const detail = plainSlackText(failure.message.trim().slice(0, 1200));
	return `${agent} couldn’t complete this request.${detail ? `\n${detail}` : ""}\nOpen the workspace in Zuse to resolve the error, then retry. You can also choose another agent in Slack Home and start a new thread.`;
};

export const turnResultText = (
	text: string | undefined,
	outcome: string | undefined,
): string => {
	if (outcome === "error")
		return `${text?.trim() ? `The agent failed before completing this request.\n${markdownToSlack(text)}\n` : "The agent failed before returning a result. "}Open the workspace in Zuse to check its error and agent connection, then retry. You can choose another agent in Slack Home and start a new thread.`;
	if (text?.trim()) return markdownToSlack(text);
	if (outcome === "interrupted")
		return "This request was interrupted before completion. Send another request when you’re ready.";
	return `The agent finished this turn (${outcome ?? "completed"}).`;
};
