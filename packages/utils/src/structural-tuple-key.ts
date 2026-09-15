/** Collision-free process-local key for an ordered tuple of string identities. */
export const structuralTupleKey = (...parts: ReadonlyArray<string>): string =>
	JSON.stringify(parts);
