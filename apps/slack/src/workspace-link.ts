import { cloudChatRoute } from "@zuse/client-runtime/environment-scope";
import { HOSTED_APP_URL } from "@zuse/contracts/deployment";
import type { RunnerEnv } from "./runner.ts";

/** An authenticated locator, never a sharing grant or credential. */
export const workspaceLink = (
	env: Pick<RunnerEnv, "WORKSPACE_APP_ORIGIN" | "WORKSPACE_SCOPE">,
	workspaceId: string,
): string => {
	const url = new URL(
		cloudChatRoute({
			workspaceId,
			scope: env.WORKSPACE_SCOPE ?? { kind: "personal" },
		}),
		env.WORKSPACE_APP_ORIGIN ?? HOSTED_APP_URL,
	);
	return `<${url.href}|View in Zuse>`;
};
