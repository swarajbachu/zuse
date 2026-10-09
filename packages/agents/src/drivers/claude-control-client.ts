import {
	type Query,
	query,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	applyClaudeCredentialEnv,
	type ClaudeManagedCredential,
} from "./claude.ts";
import { isolatedProviderAccountEnv } from "./provider-account-env.ts";

export interface ClaudeControlOptions {
	readonly claudeExecutablePath: string | null;
	readonly credential: ClaudeManagedCredential | null;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly accountHome?: string;
}

/** A read-only control query: never submits a prompt or persists a session. */
export const withClaudeControlClient = async <A>(
	args: ClaudeControlOptions,
	run: (client: Query) => Promise<A>,
): Promise<A> => {
	const abort = new AbortController();
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const idle: AsyncIterable<SDKUserMessage> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				await released;
				return { done: true, value: undefined };
			},
		}),
	};
	let client: Query | undefined;
	let rejectAborted: (reason: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAborted = reject;
	});
	const onAbort = () => {
		abort.abort();
		rejectAborted(
			new DOMException(
				"Claude control request timed out or was cancelled",
				"TimeoutError",
			),
		);
	};
	const timer = setTimeout(onAbort, args.timeoutMs);
	args.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (args.signal?.aborted) onAbort();
		else
			client = query({
				prompt: idle,
				options: {
					cwd: args.cwd,
					abortController: abort,
					env: args.accountHome
						? isolatedProviderAccountEnv(
								"claude",
								args.accountHome,
								process.env,
							)
						: applyClaudeCredentialEnv(process.env, args.credential),
					maxTurns: 1,
					persistSession: false,
					tools: [],
					settingSources: [],
					settings: { disableAllHooks: true },
					...(args.claudeExecutablePath !== null
						? { pathToClaudeCodeExecutable: args.claudeExecutablePath }
						: {}),
				},
			});
		return await Promise.race([aborted, client ? run(client) : aborted]);
	} finally {
		clearTimeout(timer);
		args.signal?.removeEventListener("abort", onAbort);
		release();
		abort.abort();
		try {
			client?.close();
		} catch {
			/* Already exited. */
		}
	}
};
