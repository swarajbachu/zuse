type ApprovalStatus = { readonly state: string };

const waitForNextRead = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 1_000));

/**
 * Reads approval state sequentially. A local Bonjour proxy is intentionally
 * narrow, so overlapping fetches can starve the request that carries the
 * terminal approval.
 */
export const pollNearbyApproval = async <Status extends ApprovalStatus>(input: {
	readonly readStatus: () => Promise<Status>;
	readonly isCancelled: () => boolean;
	readonly wait?: () => Promise<void>;
	readonly onReadError?: (cause: unknown, consecutiveFailures: number) => void;
	readonly maximumConsecutiveFailures?: number;
}): Promise<Status | null> => {
	const wait = input.wait ?? waitForNextRead;
	const maximumConsecutiveFailures = input.maximumConsecutiveFailures ?? 5;
	let consecutiveFailures = 0;

	while (!input.isCancelled()) {
		try {
			const status = await input.readStatus();
			consecutiveFailures = 0;
			if (status.state !== "pending") return status;
		} catch (cause) {
			consecutiveFailures += 1;
			input.onReadError?.(cause, consecutiveFailures);
			if (consecutiveFailures >= maximumConsecutiveFailures) throw cause;
		}
		if (!input.isCancelled()) await wait();
	}

	return null;
};
