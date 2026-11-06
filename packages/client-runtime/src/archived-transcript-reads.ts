import type { Message, MessageId, SessionStreamCursor } from "@zuse/contracts";

export type ArchivedTranscriptWindow = {
	cursor: SessionStreamCursor;
	beforeSequence: number | null;
	cacheBytes: number;
	messages: readonly Message[];
	olderMessageSequence: number | null;
};

type Flight = {
	controller: AbortController;
	readers: number;
	settled: boolean;
	request: Promise<ArchivedTranscriptWindow | null>;
};

/** One account/version-scoped walk: share downloads and serialize archive I/O. */
export class ArchivedTranscriptReads {
	private cache = new Map<
		string,
		{ value: ArchivedTranscriptWindow; bytes: number; expires: number }
	>();
	private locations = new Map<
		MessageId,
		{
			cursor: SessionStreamCursor;
			beforeSequence: number | null;
			expires: number;
		}
	>();
	private users = 0;
	get busy(): boolean {
		return this.users > 0 || this.flights.size > 0;
	}
	retain(): () => void {
		this.users++;
		return () => {
			this.users--;
			this.retireIfEmpty();
		};
	}
	locate(id: MessageId) {
		if (!this.current()) return undefined;
		this.expire();
		const location = this.locations.get(id);
		if (location) {
			this.locations.delete(id);
			this.locations.set(id, location);
		}
		return location;
	}
	private flights = new Map<string, Flight>();
	private tail: Promise<void> = Promise.resolve();
	private bytes = 0;
	private expiry: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	constructor(
		private readonly valid: () => boolean,
		private readonly inactive?: () => void,
	) {}
	readonly current = () => !this.disposed && this.valid();

	clear(): void {
		this.disposed = true;
		if (this.expiry !== null) clearTimeout(this.expiry);
		this.expiry = null;
		this.cache.clear();
		this.locations.clear();
		this.bytes = 0;
		for (const flight of this.flights.values()) flight.controller.abort();
		this.flights.clear();
	}

	private retireIfEmpty(): void {
		if (
			this.inactive &&
			!this.busy &&
			this.cache.size === 0 &&
			this.locations.size === 0 &&
			!this.disposed
		) {
			this.clear();
			this.inactive();
		}
	}
	private remove(key: string): void {
		const entry = this.cache.get(key);
		if (entry) this.bytes -= entry.bytes;
		this.cache.delete(key);
	}

	private expire(): void {
		if (this.expiry !== null) clearTimeout(this.expiry);
		this.expiry = null;
		const now = Date.now();
		for (const [key, entry] of this.cache)
			if (entry.expires <= now) this.remove(key);
		for (const [id, entry] of this.locations)
			if (entry.expires <= now) this.locations.delete(id);
		const next = Math.min(
			...[...this.cache.values(), ...this.locations.values()].map(
				(entry) => entry.expires,
			),
		);
		if (Number.isFinite(next))
			this.expiry = setTimeout(
				() => {
					this.expire();
					this.retireIfEmpty();
				},
				Math.max(0, next - now),
			);
	}

	private remember(key: string, value: ArchivedTranscriptWindow): void {
		const expires = Date.now() + 30_000;
		const location = {
			cursor: value.cursor,
			beforeSequence: value.beforeSequence,
			expires,
		};
		for (const message of value.messages) {
			if (message.id.length > 256) continue;
			this.locations.delete(message.id);
			this.locations.set(message.id, location);
			while (this.locations.size > 4096) {
				const oldest = this.locations.keys().next().value;
				if (oldest === undefined) break;
				this.locations.delete(oldest);
			}
		}
		// Decompressed UTF-8 size times two bounds serialized UTF-16 text.
		// This avoids serializing a large decrypted window again on the UI thread.
		const bytes = value.cacheBytes;
		if (bytes > 4 * 1024 * 1024) {
			this.expire();
			return;
		}
		this.remove(key);
		while (this.cache.size >= 16 || this.bytes + bytes > 4 * 1024 * 1024) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.remove(oldest);
		}
		this.cache.set(key, { value, bytes, expires });
		this.bytes += bytes;
		this.expire();
	}

	async read(
		key: string,
		load: (signal: AbortSignal) => Promise<ArchivedTranscriptWindow | null>,
		signal?: AbortSignal,
	): Promise<ArchivedTranscriptWindow | null> {
		signal?.throwIfAborted();
		if (!this.current()) {
			this.clear();
			throw new Error("The conversation changed while loading details");
		}
		this.expire();
		const cached = this.cache.get(key);
		if (cached) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached.value;
		}
		let flight = this.flights.get(key);
		if (!flight || flight.controller.signal.aborted) {
			const controller = new AbortController();
			const entry: Flight = {
				controller,
				readers: 0,
				settled: false,
				request: Promise.resolve(null),
			};
			entry.request = this.tail
				.then(async () => {
					controller.signal.throwIfAborted();
					if (!this.current())
						throw new Error("The conversation changed while loading details");
					const value = await load(controller.signal);
					controller.signal.throwIfAborted();
					if (!this.current())
						throw new Error("The conversation changed while loading details");
					if (value !== null) this.remember(key, value);
					return value;
				})
				.finally(() => {
					entry.settled = true;
					if (this.flights.get(key) === entry) this.flights.delete(key);
					this.retireIfEmpty();
				});
			this.tail = entry.request.then(
				() => undefined,
				() => undefined,
			);
			this.flights.set(key, entry);
			flight = entry;
		}
		const shared = flight;
		shared.readers++;
		return new Promise((resolve, reject) => {
			let finished = false;
			const finish = (
				value: ArchivedTranscriptWindow | null,
				error?: unknown,
				failed = false,
			) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", abort);
				if (--shared.readers === 0 && !shared.settled)
					shared.controller.abort();
				if (failed) reject(error);
				else resolve(value);
			};
			const abort = () =>
				finish(
					null,
					signal?.reason ?? new Error("Detail read cancelled"),
					true,
				);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			shared.request.then(
				(value) => finish(value),
				(error) => finish(null, error, true),
			);
		});
	}
}
