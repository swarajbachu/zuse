import type {
	ExtensionClientContext,
	ExtensionWorkspacePanelProps,
} from "@zuse/extension-sdk";
import { workspaceToolSearch } from "@zuse/extension-sdk";
import { WorkspaceTool } from "@zuse/extension-sdk/client";

const Panel = (props: ExtensionWorkspacePanelProps) => (
	<WorkspaceTool
		{...props}
		title="Code Follow-ups"
		description="Find unfinished work and give your agent the exact context."
		mode="scan"
	/>
);
export default function setup(e: ExtensionClientContext) {
	e.addWorkspacePanel({
		id: "main",
		title: "Code Follow-ups",
		icon: "package",
		Component: Panel,
	});
	e.addAttachmentSource({
		id: "context",
		title: "Code Follow-ups",
		icon: "package",
		pickerTitle: "Code Follow-ups",
		searchPlaceholder: "Search loaded results…",
		search: workspaceToolSearch,
	});
	e.addCommand({
		id: "open",
		title: "Code Follow-ups: Open scanner",
		icon: "package",
		context: "project",
		run: ({ openWorkspacePanel }) => openWorkspacePanel("main"),
	});
	return () => {};
}
