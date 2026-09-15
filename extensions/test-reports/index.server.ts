import type { ExtensionServerContext } from "@zuse/extension-sdk";
import { registerWorkspaceTool } from "@zuse/extension-sdk/server";
import { parseReport } from "./report.ts";
export default function setup(e: ExtensionServerContext) {
	return registerWorkspaceTool(e, { extensions: [".xml"], read: parseReport });
}
