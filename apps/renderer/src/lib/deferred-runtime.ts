export interface DeferredRuntime<Runtime> {
	readonly dispatch: (operation: (runtime: Runtime) => void) => void;
	readonly ready: () => Promise<Runtime>;
}

/**
 * Loads a non-critical runtime once and preserves the order of work submitted
 * while its chunk is in flight.
 */
export const createDeferredRuntime = <Runtime>(
	load: () => Promise<Runtime>,
): DeferredRuntime<Runtime> => {
	let runtime: Runtime | null = null;
	let pending: Array<(runtime: Runtime) => void> = [];
	let loading: Promise<Runtime> | null = null;
	const ensureLoading = (): Promise<Runtime> => {
		loading ??= load().then((loaded) => {
			runtime = loaded;
			const queued = pending;
			pending = [];
			for (const operation of queued) operation(loaded);
			return loaded;
		});
		return loading;
	};

	return {
		dispatch: (operation) => {
			if (runtime !== null) {
				operation(runtime);
				return;
			}
			pending.push(operation);
			void ensureLoading().catch(() => {
				pending = [];
			});
		},
		ready: ensureLoading,
	};
};
