export class WorkerClosedError extends Error {
	constructor() {
		super("worker is closed");
		this.name = "WorkerClosedError";
	}
}

export class DrainableWorker {
	private tail: Promise<void> = Promise.resolve();
	private accepting = true;
	private pending = 0;

	run<A>(operation: () => PromiseLike<A> | A): Promise<A> {
		if (!this.accepting) return Promise.reject(new WorkerClosedError());
		this.pending += 1;
		const result = this.tail.then(operation);
		this.tail = result
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				this.pending -= 1;
			});
		return result;
	}

	get size(): number {
		return this.pending;
	}

	drain(): Promise<void> {
		return this.tail;
	}

	async close(): Promise<void> {
		this.accepting = false;
		await this.drain();
	}
}
