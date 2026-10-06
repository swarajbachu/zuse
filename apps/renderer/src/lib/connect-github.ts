import { runCloudControl } from "./control-plane-client.ts";
import { openExternal } from "./platform-capabilities.ts";

/** Connect an installation to the current workspace, preserving browser activation. */
export const connectGithub = () =>
	openExternal(async () => {
		const result = await runCloudControl((client) =>
			client["cloud.github.install"](),
		);
		return result.url;
	});
