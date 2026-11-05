import {
	type Automation,
	type AutomationCapabilities,
	type AutomationConfig,
	type AutomationRun,
	type AutomationTemplate,
	CommandId,
	EnvironmentId,
} from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "./environment-shell-client-bus.ts";

export const automationClient = (environmentId: string) => {
	const command = async <Result>(
		kind: string,
		payload: unknown,
	): Promise<Result> => {
		const receipt = await dispatchEnvironmentShellCommand<unknown, Result>({
			environmentId: EnvironmentId.make(environmentId),
			kind,
			commandId: CommandId.make(`automation:${crypto.randomUUID()}`),
			payload,
			retry: "never",
		});
		return receipt.result;
	};
	return {
		capabilities: () =>
			command<AutomationCapabilities>("automation.capabilities", {}),
		templates: () =>
			command<ReadonlyArray<AutomationTemplate>>("automation.templates", {}),
		get: (id: string) => command<Automation>("automation.get", { id }),
		list: () => command<ReadonlyArray<Automation>>("automation.list", {}),
		save: (config: AutomationConfig, record?: Automation, requestId?: string) =>
			command<Automation>("automation.save", {
				config,
				...(requestId ? { requestId } : {}),
				...(record ? { id: record.id, expectedRevision: record.revision } : {}),
			}),
		remove: (id: string) => command<void>("automation.delete", { id }),
		run: (id: string, requestId: string) =>
			command<AutomationRun>("automation.run", { id, requestId }),
		runs: (id: string) =>
			command<ReadonlyArray<AutomationRun>>("automation.runs", {
				id,
				limit: 100,
			}),
		cancel: (runId: string) =>
			command<AutomationRun>("automation.cancel", { runId }),
	};
};

/** Open the cloud agent chat a run started, resolving it through the catalog. */
export const openAutomationCloudRun = async (
	workspaceId: string,
): Promise<void> => {
	const [{ useCloudChatCatalogStore }, { openCloudChat }, { runCloudControl }] =
		await Promise.all([
			import("./cloud-workspace-catalog.ts"),
			import("./cloud-workspaces.ts"),
			import("./control-plane-client.ts"),
		]);
	const cached = useCloudChatCatalogStore
		.getState()
		.summaries.find((summary) => summary.workspaceId === workspaceId);
	const summary =
		cached ??
		(
			await runCloudControl((client) =>
				client["cloud.chats.list"]({ scope: "all" }),
			)
		).chats.find((chat) => chat.workspaceId === workspaceId);
	if (!summary) throw new Error("This cloud agent is no longer available.");
	await openCloudChat(summary);
};
