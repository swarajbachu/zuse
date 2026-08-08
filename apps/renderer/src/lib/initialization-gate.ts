/** Shares initialization work while allowing a failed attempt to be retried. */
export const createInitializationGate = () => {
	let inFlight: Promise<void> | null = null;
	return (
		initialized: boolean,
		initialize: () => Promise<void>,
	): Promise<void> => {
		if (initialized) return Promise.resolve();
		if (inFlight !== null) return inFlight;
		let attempt: Promise<void>;
		try {
			attempt = initialize();
		} catch (cause) {
			attempt = Promise.reject(cause);
		}
		inFlight = attempt.finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
};
