import { DrainableWorker, WorkerClosedError } from "./drainable-worker.js";

type Waiter<A> = {
	readonly resolve: (value: A) => void;
	readonly reject: (cause: unknown) => void;
};

type Pending<A> = {
	operation: () => PromiseLike<A> | A;
	readonly waiters: Array<Waiter<A>>;
};

type Entry<A> = {
	readonly worker: DrainableWorker;
	pending: Pending<A> | null;
	running: boolean;
};

export class KeyedCoalescingWorker<K, A> {
	private readonly entries = new Map<K, Entry<A>>();
	private accepting = true;

	run(key: K, operation: () => PromiseLike<A> | A): Promise<A> {
		if (!this.accepting) return Promise.reject(new WorkerClosedError());
		let entry = this.entries.get(key);
		if (entry === undefined) {
			entry = { worker: new DrainableWorker(), pending: null, running: false };
			this.entries.set(key, entry);
		}

		const result = new Promise<A>((resolve, reject) => {
			if (entry.pending === null) {
				entry.pending = { operation, waiters: [{ resolve, reject }] };
			} else {
				entry.pending.operation = operation;
				entry.pending.waiters.push({ resolve, reject });
			}
		});
		this.pump(key, entry);
		return result;
	}

	private pump(key: K, entry: Entry<A>): void {
		if (entry.running || entry.pending === null) return;
		const pending = entry.pending;
		entry.pending = null;
		entry.running = true;
		void entry.worker
			.run(pending.operation)
			.then(
				(value) => {
					for (const waiter of pending.waiters) waiter.resolve(value);
				},
				(cause) => {
					for (const waiter of pending.waiters) waiter.reject(cause);
				},
			)
			.finally(() => {
				entry.running = false;
				if (entry.pending === null) {
					this.entries.delete(key);
				} else {
					this.pump(key, entry);
				}
			});
	}

	async drain(): Promise<void> {
		while (this.entries.size > 0) {
			await Promise.all(
				[...this.entries.values()].map((entry) => entry.worker.drain()),
			);
			await Promise.resolve();
		}
	}

	async close(): Promise<void> {
		this.accepting = false;
		await this.drain();
	}
}
