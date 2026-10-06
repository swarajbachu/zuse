import type { CloudGithubCredentialRequest } from "@zuse/contracts";
import { Context } from "effect";

export interface GitExecutionEnvironment {
	readonly key: string;
	readonly context: typeof CloudGithubCredentialRequest.Type;
	readonly env: Readonly<Record<string, string>>;
}
export type GitExecutionResolver = (
	sessionId: string,
) => Promise<GitExecutionEnvironment | undefined>;

/** Internal runtime hook. Caller-supplied provider options cannot choose a GitHub actor. */
export class RuntimeGitExecution extends Context.Service<
	RuntimeGitExecution,
	{
		readonly resolve: GitExecutionResolver;
		readonly install: (resolve: GitExecutionResolver) => () => void;
	}
>()("zuse/RuntimeGitExecution") {}

export const makeRuntimeGitExecution = (
	waitForInstallation = false,
): RuntimeGitExecution["Service"] => {
	let current: GitExecutionResolver | undefined;
	let ready: (() => void) | undefined;
	const installed = new Promise<void>((resolve) => {
		ready = resolve;
	});
	return {
		resolve: async (sessionId) => {
			if (waitForInstallation) {
				await installed;
				if (current === undefined)
					throw new Error("Cloud GitHub execution is unavailable");
			}
			return current?.(sessionId);
		},
		install: (resolve) => {
			current = resolve;
			ready?.();
			return () => {
				if (current === resolve) current = undefined;
			};
		},
	};
};
