export type CommandDispatchOptions = {
	readonly shouldRetry?: (cause: unknown) => boolean;
};

type CommandEntry<A> = {
	readonly commandId: string;
	readonly dispatch: () => Promise<A>;
	readonly shouldRetry: (cause: unknown) => boolean;
	readonly receipt: Promise<A>;
	readonly resolve: (value: A) => void;
	readonly reject: (cause: unknown) => void;
	settled: boolean;
	inFlight: boolean;
};

const deferred = <A>() => {
	let resolve!: (value: A) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<A>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
};

export class CommandDispatcher {
	private readonly entries = new Map<string, CommandEntry<unknown>>();

	dispatch<A>(
		commandId: string,
		operation: () => Promise<A>,
		options: CommandDispatchOptions = {},
	): Promise<A> {
		const existing = this.entries.get(commandId) as CommandEntry<A> | undefined;
		if (existing !== undefined) return existing.receipt;

		const receipt = deferred<A>();
		const entry: CommandEntry<A> = {
			commandId,
			dispatch: operation,
			shouldRetry: options.shouldRetry ?? (() => false),
			receipt: receipt.promise,
			resolve: receipt.resolve,
			reject: receipt.reject,
			settled: false,
			inFlight: false,
		};
		this.entries.set(commandId, entry as CommandEntry<unknown>);
		this.run(entry);
		return entry.receipt;
	}

	redispatchPending(): readonly Promise<unknown>[] {
		const receipts: Promise<unknown>[] = [];
		for (const entry of this.entries.values()) {
			if (entry.settled) continue;
			this.run(entry);
			receipts.push(entry.receipt);
		}
		return receipts;
	}

	failPending(cause: unknown): void {
		for (const entry of this.entries.values()) {
			if (entry.settled) continue;
			entry.settled = true;
			entry.reject(cause);
		}
		this.entries.clear();
	}

	get pendingCommandIds(): readonly string[] {
		return [...this.entries.values()]
			.filter((entry) => !entry.settled)
			.map((entry) => entry.commandId);
	}

	private run<A>(entry: CommandEntry<A>): void {
		if (entry.inFlight || entry.settled) return;
		entry.inFlight = true;
		void entry.dispatch().then(
			(value) => {
				entry.inFlight = false;
				entry.settled = true;
				this.entries.delete(entry.commandId);
				entry.resolve(value);
			},
			(cause) => {
				entry.inFlight = false;
				if (entry.shouldRetry(cause)) return;
				entry.settled = true;
				this.entries.delete(entry.commandId);
				entry.reject(cause);
			},
		);
	}
}
