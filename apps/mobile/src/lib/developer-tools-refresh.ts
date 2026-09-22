import type { PtyOwnerId } from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";

const DEVELOPER_TOOLS_RPC_CONCURRENCY = 4;

type DeveloperTerminalTarget = Readonly<{
	connectionKey: string;
	ownerId: PtyOwnerId;
}>;

/** One owner catalog is fetched at most once from each logical connection. */
export const uniqueDeveloperTerminalTargets = <
	Target extends DeveloperTerminalTarget,
>(
	targets: ReadonlyArray<Target>,
): ReadonlyArray<Target> => {
	const unique = new Map<string, Target>();
	for (const target of targets) {
		const key = structuralTupleKey(target.connectionKey, target.ownerId);
		if (!unique.has(key)) unique.set(key, target);
	}
	return [...unique.values()];
};

/** Run diagnostic RPC work without opening an unbounded socket/request burst. */
export const runBoundedDeveloperToolTasks = async <Result>(
	tasks: ReadonlyArray<() => Promise<Result>>,
	concurrency = DEVELOPER_TOOLS_RPC_CONCURRENCY,
): Promise<ReadonlyArray<Result>> => {
	if (tasks.length === 0) return [];
	const normalizedConcurrency =
		Number.isSafeInteger(concurrency) && concurrency > 0
			? concurrency
			: DEVELOPER_TOOLS_RPC_CONCURRENCY;
	const results = new Array<Result>(tasks.length);
	let nextIndex = 0;
	const failure: { failed: boolean; cause?: unknown } = { failed: false };
	const worker = async (): Promise<void> => {
		while (!failure.failed) {
			const index = nextIndex;
			nextIndex += 1;
			const task = tasks[index];
			if (task === undefined) return;
			try {
				results[index] = await task();
			} catch (cause) {
				if (!failure.failed) {
					failure.failed = true;
					failure.cause = cause;
				}
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(normalizedConcurrency, tasks.length) },
			worker,
		),
	);
	if (failure.failed) throw failure.cause;
	return results;
};

export type DeveloperToolsRefreshAuthority = Readonly<{
	begin: () => symbol;
	isCurrent: (token: symbol) => boolean;
	invalidate: () => void;
}>;

/** Commit fence for overlapping pull-to-refresh and dependency refreshes. */
export const makeDeveloperToolsRefreshAuthority =
	(): DeveloperToolsRefreshAuthority => {
		let current: symbol | null = null;
		return {
			begin: () => {
				const token = Symbol("developer-tools-refresh");
				current = token;
				return token;
			},
			isCurrent: (token) => current === token,
			invalidate: () => {
				current = null;
			},
		};
	};
