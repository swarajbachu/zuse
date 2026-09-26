import type {
	ExtensionClientContext,
	ExtensionWorkspacePanelProps,
} from "@zuse/extension-sdk";
import { workspaceToolSearch } from "@zuse/extension-sdk";
import { WorkspaceTool } from "@zuse/extension-sdk/client";

const Panel = (props: ExtensionWorkspacePanelProps) => (
	<WorkspaceTool
		{...props}
		title="Project Playbook"
		description="Bring your team’s procedures into any agent conversation."
		mode="file"
	/>
);
export default function setup(e: ExtensionClientContext) {
	e.addWorkspacePanel({
		id: "main",
		title: "Project Playbook",
		icon: "package",
		Component: Panel,
	});
	e.addAttachmentSource({
		id: "context",
		title: "Project Playbook",
		icon: "package",
		pickerTitle: "Project Playbook",
		searchPlaceholder: "Search loaded results…",
		search: workspaceToolSearch,
	});
	return () => {};
}
