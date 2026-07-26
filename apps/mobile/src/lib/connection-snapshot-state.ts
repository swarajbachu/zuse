import type { ConnectionSnapshot } from "~/rpc/connection";

const sameSnapshot = (
	left: ConnectionSnapshot | undefined,
	right: ConnectionSnapshot,
): boolean =>
	left === right ||
	(left !== undefined &&
		left.key === right.key &&
		left.status === right.status &&
		left.generation === right.generation &&
		left.attempt === right.attempt &&
		left.error === right.error);

export const setConnectionSnapshot = (
	state: Readonly<Record<string, ConnectionSnapshot>>,
	connKey: string,
	snapshot: ConnectionSnapshot,
): Readonly<Record<string, ConnectionSnapshot>> =>
	sameSnapshot(state[connKey], snapshot)
		? state
		: { ...state, [connKey]: snapshot };
