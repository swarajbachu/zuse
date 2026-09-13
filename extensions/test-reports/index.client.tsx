import type {
	ExtensionClientContext,
	ExtensionWorkspacePanelProps,
} from "@zuse/extension-sdk";
import { workspaceToolSearch } from "@zuse/extension-sdk";
import { WorkspaceTool } from "@zuse/extension-sdk/client";

const Panel = (props: ExtensionWorkspacePanelProps) => (
	<WorkspaceTool
		{...props}
		title="Test Reports"
		description="Turn a failed test report into the next agent task."
		mode="file"
		statuses={["failed", "error", "skipped", "passed"]}
	/>
);
export default function setup(e: ExtensionClientContext) {
	e.addWorkspacePanel({
		id: "main",
		title: "Test Reports",
		icon: "package",
		Component: Panel,
	});
	e.addAttachmentSource({
		id: "context",
		title: "Test Reports",
		icon: "package",
		pickerTitle: "Test Reports",
		searchPlaceholder: "Search loaded results…",
		search: workspaceToolSearch,
	});
	return () => {};
}
