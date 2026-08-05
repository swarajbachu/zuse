type ActiveRefresh<Options> = {
	promise: Promise<void>;
	queuedOptions: Options | null;
};

export const createConnectionRefreshCoordinator = <Options>(
	run: (key: string, options: Options) => Promise<boolean>,
) => {
	const active = new Map<string, ActiveRefresh<Options>>();
	const requestedGenerations = new Map<string, number>();

	const hydrate = (key: string, options: Options): Promise<void> => {
		const existing = active.get(key);
		if (existing !== undefined) return existing.promise;

		const refresh: ActiveRefresh<Options> = {
			promise: Promise.resolve(),
			queuedOptions: null,
		};
		refresh.promise = (async () => {
			let failure: unknown;
			let authoritative = false;
			try {
				authoritative = await run(key, options);
			} catch (cause) {
				failure = cause;
			}

			if (active.get(key) !== refresh) return;
			active.delete(key);
			if (!authoritative && refresh.queuedOptions !== null) {
				await hydrate(key, refresh.queuedOptions);
				return;
			}
			if (failure !== undefined) throw failure;
		})();
		active.set(key, refresh);
		return refresh.promise;
	};

	const refreshConnected = (
		key: string,
		options: Options,
		generation: number,
	): Promise<void> => {
		if ((requestedGenerations.get(key) ?? 0) >= generation) {
			return active.get(key)?.promise ?? Promise.resolve();
		}
		requestedGenerations.set(key, generation);
		const existing = active.get(key);
		if (existing !== undefined) {
			existing.queuedOptions = options;
			return existing.promise;
		}
		return hydrate(key, options);
	};

	const reset = (): void => {
		active.clear();
		requestedGenerations.clear();
	};

	return { hydrate, refreshConnected, reset };
};
