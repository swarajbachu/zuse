/**
 * Mutable authority whose identity changes only when React's commit phase says
 * so. Render may compute a speculative value without revoking async work owned
 * by the still-committed surface.
 */
export type CommittedAuthority<Value> = Readonly<{
	commit: (value: Value) => void;
	current: () => Value;
	isCurrent: (value: Value) => boolean;
}>;

export const makeCommittedAuthority = <Value>(
	initial: Value,
): CommittedAuthority<Value> => {
	let committed = initial;
	return {
		commit: (value) => {
			committed = value;
		},
		current: () => committed,
		isCurrent: (value) => Object.is(committed, value),
	};
};
