type PendingRead = {
	controller: AbortController;
	promise: Promise<unknown>;
	users: number;
	settled: boolean;
};

/** Cancellation belongs to each consumer; the request stops when the last one leaves. */
export class GitHubSharedReads {
	private readonly pending = new Map<string, PendingRead>();
	run<T>(
		key: string,
		signal: AbortSignal,
		read: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		signal.throwIfAborted();
		let entry = this.pending.get(key);
		if (!entry) {
			const controller = new AbortController();
			const created: PendingRead = {
				controller,
				users: 0,
				settled: false,
				promise: Promise.resolve().then(() => read(controller.signal)),
			};
			entry = created;
			this.pending.set(key, entry);
			void entry.promise.then(
				() => this.settle(key, created),
				() => this.settle(key, created),
			);
		}
		entry.users++;
		const current = entry;
		return new Promise<T>((resolve, reject) => {
			let finished = false;
			const finish = () => {
				if (finished) return false;
				finished = true;
				signal.removeEventListener("abort", abort);
				current.users--;
				if (!current.users && !current.settled) {
					if (this.pending.get(key) === current) this.pending.delete(key);
					current.controller.abort();
				}
				return true;
			};
			const abort = () => {
				if (finish()) reject(signal.reason);
			};
			signal.addEventListener("abort", abort, { once: true });
			void current.promise.then(
				(value) => {
					if (finish()) resolve(value as T);
				},
				(error) => {
					if (finish()) reject(error);
				},
			);
			if (signal.aborted) abort();
		});
	}
	private settle(key: string, entry: PendingRead): void {
		entry.settled = true;
		if (this.pending.get(key) === entry) this.pending.delete(key);
	}
	close(): void {
		for (const entry of this.pending.values()) entry.controller.abort();
		this.pending.clear();
	}
}
