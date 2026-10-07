export interface ReviewFixLink {
	readonly runId: string;
	readonly findingId?: string;
}

const isOpaqueId = (value: string): boolean =>
	/^[A-Za-z0-9_-]{1,256}$/u.test(value);

/** A navigation hint only. The authenticated API must authorize the referenced run. */
export function parseReviewFixLink(value: string): ReviewFixLink | null {
	if (value.length > 1024) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "zuse:" ||
			url.host ||
			url.username ||
			url.password ||
			url.hash ||
			url.pathname !== "/review/fix"
		)
			return null;
		if (
			[...url.searchParams.keys()].some(
				(key) => key !== "runId" && key !== "findingId",
			)
		)
			return null;
		const runIds = url.searchParams.getAll("runId");
		const findingIds = url.searchParams.getAll("findingId");
		const runId = runIds[0];
		const findingId = findingIds[0];
		if (
			runIds.length !== 1 ||
			!runId ||
			!isOpaqueId(runId) ||
			findingIds.length > 1 ||
			(findingId !== undefined && !isOpaqueId(findingId))
		)
			return null;
		return { runId, ...(findingId !== undefined ? { findingId } : {}) };
	} catch {
		return null;
	}
}

export function buildReviewFixLink(input: ReviewFixLink): string {
	if (
		!isOpaqueId(input.runId) ||
		(input.findingId !== undefined && !isOpaqueId(input.findingId))
	)
		throw new Error("Invalid review link identifier");
	const url = new URL("zuse:///review/fix");
	url.searchParams.set("runId", input.runId);
	if (input.findingId !== undefined)
		url.searchParams.set("findingId", input.findingId);
	return url.toString();
}
