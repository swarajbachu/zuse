export interface CloseableResource {
	readonly close: () => void | Promise<void>;
}

interface ResourceEntry<Resource extends CloseableResource> {
	readonly resource: Promise<Resource>;
	leases: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface SharedResourcePool<Key, Resource extends CloseableResource> {
	readonly use: <Result>(
		key: Key,
		run: (resource: Resource) => Promise<Result>,
	) => Promise<Result>;
	readonly dispose: () => Promise<void>;
}

/**
 * Owns keyed, multiplexable provider resources behind lease-based idle
 * teardown. Concurrent callers share initialization; distinct provider
 * configurations remain isolated; failed starts are evicted for retry.
 */
export const createSharedResourcePool = <
	Key,
	Resource extends CloseableResource,
>(options: {
	readonly create: (key: Key) => Promise<Resource>;
	readonly idleTimeoutMs: number;
}): SharedResourcePool<Key, Resource> => {
	const entries = new Map<Key, ResourceEntry<Resource>>();
	let disposed = false;

	const closeEntry = async (
		key: Key,
		entry: ResourceEntry<Resource>,
	): Promise<void> => {
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		if (entries.get(key) === entry) entries.delete(key);
		try {
			const resource = await entry.resource;
			await resource.close();
		} catch {
			// Failed creation has no live resource to close. Provider shutdown is
			// best-effort and must not turn process teardown into an unhandled error.
		}
	};

	const scheduleIdleClose = (
		key: Key,
		entry: ResourceEntry<Resource>,
	): void => {
		if (entry.leases !== 0 || entry.idleTimer !== null || disposed) return;
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = null;
			if (entry.leases !== 0 || entries.get(key) !== entry) return;
			void closeEntry(key, entry);
		}, options.idleTimeoutMs);
		entry.idleTimer.unref?.();
	};

	const use = async <Result>(
		key: Key,
		run: (resource: Resource) => Promise<Result>,
	): Promise<Result> => {
		if (disposed) throw new Error("Shared resource pool is disposed");

		let entry = entries.get(key);
		if (entry === undefined) {
			entry = {
				resource: options.create(key),
				leases: 0,
				idleTimer: null,
			};
			entries.set(key, entry);
			void entry.resource.catch(() => {
				if (entries.get(key) === entry) entries.delete(key);
			});
		}

		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.leases += 1;
		try {
			const resource = await entry.resource;
			if (disposed) throw new Error("Shared resource pool is disposed");
			return await run(resource);
		} finally {
			entry.leases -= 1;
			scheduleIdleClose(key, entry);
		}
	};

	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		const active = [...entries.entries()];
		entries.clear();
		await Promise.all(active.map(([key, entry]) => closeEntry(key, entry)));
	};

	return { use, dispose };
};
