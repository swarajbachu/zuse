import type { SessionTimelineProjection } from "@zuse/contracts";
import type { ClientBus } from "./client-bus.ts";
import {
	makeResourceKey,
	resourceKeyId,
	type SessionRef,
} from "./resource-ref.ts";
import type { ResourceView } from "./resource-state.ts";
import type { OlderSessionMessagesResult } from "./session-message-pager.ts";

/** Fair, bounded history fetching. Live events never pass through this queue. */
export class BackgroundHistory {
	private jobs = new Map<
		string,
		{
			refs: number;
			scope: string;
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
	private timerAt = 0;
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
		scope?: string,
	): () => void {
		let job = this.jobs.get(key);
		// Readers share work only while it belongs to the same resource lifetime.
		if (job && scope !== undefined && job.scope !== scope) {
			job.controller.abort();
			job = undefined;
		}
		if (job) job.refs++;
		else {
			job = {
				refs: 1,
				scope: scope ?? "",
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
				this.schedule();
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
		let readyAt = Number.POSITIVE_INFINITY;
		if (this.active < this.concurrency) {
			for (const job of this.jobs.values()) {
				if (!job.running && job.error === null)
					readyAt = Math.min(readyAt, job.readyAt);
			}
		}
		if (!Number.isFinite(readyAt)) {
			if (this.timer !== null) clearTimeout(this.timer);
			this.timer = null;
			return;
		}
		const now = Date.now();
		const next = Math.max(now + 16, readyAt);
		// A newly retained foreground job must not wait for another job's backoff.
		if (this.timer !== null && this.timerAt <= next) return;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timerAt = next;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.pump();
		}, next - now);
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
		this.schedule();
	}
}

/** Shared desktop/mobile lifetime for recent-first cloud history. */
export function retainSessionHistory<Client>(options: {
	bus: ClientBus<Client>;
	ref: SessionRef;
	scheduler: BackgroundHistory;
	load: (signal: AbortSignal) => Promise<OlderSessionMessagesResult>;
	priority?: () => number;
	onComplete?: () => void;
}): () => void {
	const { bus, ref, scheduler } = options;
	const key = makeResourceKey<SessionTimelineProjection>(
		"session-timeline",
		ref,
	);
	const id = resourceKeyId(key);
	let retained: { scope: string; release: () => void } | null = null;
	let disposed = false;
	const stop = () => {
		const previous = retained;
		retained = null;
		previous?.release();
	};
	const check = () => {
		if (disposed) return;
		const view = bus.snapshot(key);
		// The timeline owns whether history exists and when it is safe to read.
		// Legacy runtimes finish their synchronization barrier before paging.
		const eligible =
			view.data?.olderMessageSequence != null &&
			(view.sync === "live" || view.connection === "dormant");
		const scope = eligible
			? JSON.stringify([view.generation, view.cursor?.epoch ?? null])
			: null;
		if (scope === null) {
			stop();
			return;
		}
		if (retained?.scope === scope && scheduler.status(id) !== "idle") return;
		stop();
		retained = {
			scope,
			release: scheduler.retain(
				id,
				async (signal) => {
					const result = await options.load(signal);
					if (!result.applied && result.hasMore)
						throw new Error("History page unavailable");
					if (!result.hasMore) options.onComplete?.();
					return result.hasMore;
				},
				options.priority,
				scope,
			),
		};
	};
	const unsubscribe = bus.subscribe(key, check);
	check();
	return () => {
		disposed = true;
		unsubscribe();
		stop();
	};
}

/** Legacy runtimes finish their synchronization barrier before paging. */
export const isSessionHistoryReady = (
	view: ResourceView<SessionTimelineProjection>,
): boolean =>
	view.data?.olderMessageSequence != null &&
	(view.sync === "live" || view.connection === "dormant");

/** Explicit page demand, shared across visible readers without eager prefetch. */
export class HistoryPageDemand {
	private readers = new Map<
		string,
		{
			refs: number;
			release: (() => void) | null;
			unsubscribe: (() => void) | null;
			readiness?: {
				ready: () => boolean;
				subscribe: (listener: () => void) => () => void;
			};
			pending:
				| ((signal: AbortSignal) => Promise<OlderSessionMessagesResult>)
				| null;
		}
	>();
	constructor(private readonly scheduler: BackgroundHistory) {}
	retain(
		key: string,
		readiness?: {
			ready: () => boolean;
			subscribe: (listener: () => void) => () => void;
		},
	): () => void {
		let entry = this.readers.get(key);
		if (!entry) {
			entry = {
				refs: 0,
				release: null,
				unsubscribe: null,
				readiness,
				pending: null,
			};
			this.readers.set(key, entry);
			const current = entry;
			current.unsubscribe =
				readiness?.subscribe(() => {
					if (current.pending && readiness.ready())
						this.request(key, current.pending);
				}) ?? null;
		}
		const retained = entry;
		retained.refs++;
		return () => {
			if (this.readers.get(key) !== retained || --retained.refs > 0) return;
			retained.unsubscribe?.();
			retained.release?.();
			this.readers.delete(key);
		};
	}
	request(
		key: string,
		load: (signal: AbortSignal) => Promise<OlderSessionMessagesResult>,
	): void {
		const entry = this.readers.get(key);
		if (!entry || this.scheduler.status(key) !== "idle") return;
		if (entry.readiness && !entry.readiness.ready()) {
			entry.pending = load;
			return;
		}
		entry.pending = null;
		entry.release?.();
		entry.release = this.scheduler.retain(
			key,
			async (signal) => {
				const result = await load(signal);
				if (!result.applied && result.hasMore)
					throw new Error("History page unavailable");
				return false;
			},
			() => 10,
		);
	}
}
