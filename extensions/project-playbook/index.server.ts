import type { ExtensionServerContext } from "@zuse/extension-sdk";
import { registerWorkspaceTool } from "@zuse/extension-sdk/server";
import { parsePlaybook } from "./playbook.ts";
export default function setup(e: ExtensionServerContext) {
	return registerWorkspaceTool(e, {
		extensions: [".md", ".markdown"],
		read: parsePlaybook,
	});
}
