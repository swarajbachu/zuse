import {
	handleSimulatorTool,
	isSimulatorMutation,
	SIMULATOR_MCP_TOOLS,
	type SimulatorToolsClient,
} from "@zuse/agents/drivers/simulator-tools";
import type { HarnessHost } from "@zuse/agents/harness/types";
import type {
	PermissionDecision,
	PermissionKind,
	RuntimeMode,
} from "@zuse/contracts";

/** Reuse the provider-neutral tool definitions and policy for Zuse's native model harness. */
export function simulatorHarnessTools(options: {
	client: SimulatorToolsClient;
	sessionId: string;
	getRuntimeMode: () => RuntimeMode;
	requestPermission: (
		kind: PermissionKind,
		options: { forcePrompt: boolean },
		signal: AbortSignal,
	) => Promise<PermissionDecision>;
}): Pick<HarnessHost, "tools" | "execute"> {
	return {
		tools: Object.fromEntries(
			SIMULATOR_MCP_TOOLS.map((tool) => [
				tool.name,
				{
					description: tool.description,
					parameters: tool.inputSchema,
					category: isSimulatorMutation(tool.name) ? "other" : "read",
				},
			]),
		),
		execute: async (name, args, context) => {
			const result = await handleSimulatorTool(
				name,
				args,
				{
					client: options.client,
					getRuntimeMode: options.getRuntimeMode,
					getPermissionMode: () =>
						context.readOnly ? "plan" : context.permissionMode,
					requestPermission: (kind, input) =>
						options.requestPermission(kind, input, context.signal),
				},
				options.sessionId,
				context.signal,
			);
			const images = result.content.filter(
				(content) => content.type === "image",
			);
			if (images.length)
				return {
					type: "content",
					value: images.map((image) => ({
						type: "file",
						mediaType: image.mimeType,
						data: { type: "data", data: image.data },
					})),
				};
			return result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");
		},
	};
}
