/** A bounded FIFO. Queued cancellations release their slot immediately. */
export class PreviewQueue {
	private active = 0;
	private waiting: Array<() => void> = [];
	async run<T>(
		work: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		signal.throwIfAborted();
		if (this.active >= 2) {
			if (this.waiting.length >= 8)
				throw new Error("HTML preview queue is full; retry shortly");
			await new Promise<void>((resolve, reject) => {
				const ready = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					this.waiting = this.waiting.filter((item) => item !== ready);
					reject(signal.reason);
				};
				this.waiting.push(ready);
				signal.addEventListener("abort", abort, { once: true });
			});
		} else this.active++;
		try {
			signal.throwIfAborted();
			return await work(signal);
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}
}
