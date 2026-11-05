import { ComposerInput, defaultModelFor, type FolderId } from "@zuse/contracts";
import { useChatsStore } from "../store/chats.ts";
import { currentModelCatalog } from "../store/model-catalog.ts";
import { useUiStore } from "../store/ui.ts";
import { AGENT_SOURCE_KEY, AGENT_SOURCE_VALUE } from "./automation-format.ts";
import { rendererWorkspaceSnapshot } from "./renderer-workspace.ts";
import { getActiveEnvironment } from "./rpc-client.ts";
import { useSettingsStore } from "./settings-client-bus.ts";

export function automationAgentPrompt(
	intent: "generate" | "suggest",
	description: string,
	projectId?: FolderId,
): string {
	const request =
		intent === "suggest"
			? "Review this project's recent work and suggest valuable recurring or event-driven automations. Explain the trigger, instructions, integrations, and expected benefit for each proposal."
			: `Create an automation for this request: ${description.trim()}`;
	return `${request}${intent === "suggest" && description.trim() ? `\nFocus: ${description.trim()}` : ""}\n\nUse the native Zuse MCP tools automation_catalog and automation_save to manage the same persisted automations as this UI. Read automation_catalog first for the current project, definition schema, templates, capabilities, and existing definitions. Save the complete definition with enabled:false and include "${AGENT_SOURCE_KEY}": "${AGENT_SOURCE_VALUE}" in metadata so I can review it in the Automations page. Use a stable unique requestId and reuse that ID with identical configJson if the response is lost. Check triggers and integrations against capabilities. Do not claim creation succeeded unless automation_save confirms the persisted ID. Ask me for missing configuration and before enabling a proposed automation.${projectId ? ` The target project is ${projectId}.` : ""} If native tools are unavailable and the branch CLI is installed, use zuse automation schema/capabilities/templates/list, then zuse automation save --project ${projectId ?? "<project-id>"} --definition @automation.json --idempotency-key <stable-unique-key>. Do not search for another CLI or credentials.`;
}

export async function launchAutomationAgent(
	projectId: FolderId,
	intent: "generate" | "suggest",
	description: string,
): Promise<void> {
	const environmentId = getActiveEnvironment();
	const workspace = rendererWorkspaceSnapshot();
	const settings = useSettingsStore.getState();
	const providerId = settings.defaultProviderId;
	const result = await useChatsStore
		.getState()
		.create(
			projectId,
			providerId,
			settings.defaultModelByProvider[providerId] ??
				defaultModelFor(currentModelCatalog(), providerId),
			{
				title:
					intent === "suggest"
						? "Find automations for me"
						: "Create an automation",
				startupInput: ComposerInput.make({
					text: automationAgentPrompt(intent, description, projectId),
					attachments: [],
					fileRefs: [],
					skillRefs: [],
				}),
				preserveFocus: true,
			},
		);
	if (!result)
		throw new Error(
			useChatsStore.getState().error ?? "Could not start the automation agent.",
		);
	if (
		getActiveEnvironment() !== environmentId ||
		rendererWorkspaceSnapshot() !== workspace ||
		useUiStore.getState().activeMainTab !== "automations"
	)
		return;
	useChatsStore.getState().select(result.chatId);
	useUiStore.getState().setActiveMainTab("chat");
}
