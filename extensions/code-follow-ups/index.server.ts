import type { ExtensionServerContext } from "@zuse/extension-sdk";
import { registerWorkspaceTool } from "@zuse/extension-sdk/server";
import { scanFollowUps } from "./follow-ups.ts";
export default function setup(e: ExtensionServerContext) {
	return registerWorkspaceTool(e, { scan: scanFollowUps });
}
