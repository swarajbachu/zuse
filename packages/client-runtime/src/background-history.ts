/** Fair, bounded history fetching. Live events never pass through this queue. */
export class BackgroundHistory {
	private jobs = new Map<
		string,
		{
			refs: number;
			controller: AbortController;
			run: (signal: AbortSignal) => Promise<boolean>;
			priority: () => number;
			running: boolean;
			error: unknown;
			readyAt: number;
			attempts: number;
		}
	>();
	private active = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private listeners = new Set<() => void>();
	constructor(private readonly concurrency = 2) {}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	status = (key: string): "idle" | "loading" | "failed" => {
		const job = this.jobs.get(key);
		return job === undefined
			? "idle"
			: job.error !== null
				? "failed"
				: "loading";
	};
	retain(
		key: string,
		run: (signal: AbortSignal) => Promise<boolean>,
		priority: () => number = () => 0,
	): () => void {
		let job = this.jobs.get(key);
		if (job) job.refs++;
		else {
			job = {
				refs: 1,
				controller: new AbortController(),
				run,
				priority,
				running: false,
				error: null,
				readyAt: 0,
				attempts: 0,
			};
			this.jobs.set(key, job);
			this.emit();
		}
		this.schedule();
		const retained = job;
		return () => {
			if (this.jobs.get(key) !== retained) return;
			if (--retained.refs === 0) {
				retained.controller.abort();
				this.jobs.delete(key);
				this.emit();
			}
		};
	}
	retry(key: string): void {
		const job = this.jobs.get(key);
		if (job) {
			job.error = null;
			job.attempts = 0;
			job.readyAt = 0;
			this.emit();
			this.schedule();
		}
	}
	clear(): void {
		for (const job of this.jobs.values()) job.controller.abort();
		this.jobs.clear();
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.emit();
	}
	private emit(): void {
		for (const listener of this.listeners) listener();
	}
	private schedule(): void {
		if (
			this.timer !== null ||
			this.active >= this.concurrency ||
			this.jobs.size === 0
		)
			return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.pump();
		}, 16);
	}
	private pump(): void {
		const candidates = [...this.jobs]
			.filter(([, job]) => !job.running && job.error === null)
			.sort((a, b) => b[1].priority() - a[1].priority());
		for (const [key, job] of candidates) {
			if (this.active >= this.concurrency) break;
			if (job.readyAt > Date.now()) continue;
			job.running = true;
			this.active++;
			void job
				.run(job.controller.signal)
				.then(
					(more) => {
						if (this.jobs.get(key) !== job) return;
						job.attempts = 0;
						if (!more) {
							this.jobs.delete(key);
							this.emit();
						}
					},
					(error) => {
						if (this.jobs.get(key) !== job) return;
						job.attempts++;
						if (job.attempts >= 4) {
							job.error = error;
							this.emit();
						} else
							job.readyAt =
								Date.now() + Math.min(4000, 250 * 2 ** job.attempts);
					},
				)
				.finally(() => {
					job.running = false;
					this.active--;
					this.schedule();
				});
		}
		if (candidates.length > 0) this.schedule();
	}
}
