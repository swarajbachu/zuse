const CONTEXT_LIMIT = 8;
const activeOperations = new Map<number, string>();
let nextOperationId = 0;

export interface StallContext {
	readonly recentActions: ReadonlyArray<string>;
	readonly activeWorkloads: ReadonlyArray<string>;
	readonly relatedOperations: ReadonlyArray<string>;
}

export const getActiveStallOperations = (): ReadonlyArray<string> =>
	[...activeOperations.values()].slice(-CONTEXT_LIMIT);

export const beginStallOperation = (label: string): (() => void) => {
	const id = nextOperationId;
	nextOperationId += 1;
	activeOperations.set(
		id,
		/^(?:rpc|render|workload):[a-z0-9._-]{1,100}$/i.test(label)
			? label
			: "operation",
	);
	return () => {
		activeOperations.delete(id);
	};
};
