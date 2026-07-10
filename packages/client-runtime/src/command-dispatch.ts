type CommandEntry<A> = {
	readonly commandId: string;
	readonly dispatch: () => Promise<A>;
	promise: Promise<A>;
	settled: boolean;
};

export class CommandDispatcher {
	private readonly entries = new Map<string, CommandEntry<unknown>>();

	dispatch<A>(commandId: string, operation: () => Promise<A>): Promise<A> {
		const existing = this.entries.get(commandId) as CommandEntry<A> | undefined;
		if (existing !== undefined) return existing.promise;

		const entry: CommandEntry<A> = {
			commandId,
			dispatch: operation,
			promise: Promise.resolve(undefined as A),
			settled: false,
		};
		entry.promise = this.run(entry);
		this.entries.set(commandId, entry as CommandEntry<unknown>);
		return entry.promise;
	}

	redispatchPending(): readonly Promise<unknown>[] {
		const pending: Promise<unknown>[] = [];
		for (const entry of this.entries.values()) {
			if (entry.settled) continue;
			entry.promise = this.run(entry);
			pending.push(entry.promise);
		}
		return pending;
	}

	forget(commandId: string): void {
		this.entries.delete(commandId);
	}

	get pendingCommandIds(): readonly string[] {
		return [...this.entries.values()]
			.filter((entry) => !entry.settled)
			.map((entry) => entry.commandId);
	}

	private run<A>(entry: CommandEntry<A>): Promise<A> {
		return entry.dispatch().then(
			(value) => {
				entry.settled = true;
				return value;
			},
			(cause) => {
				throw cause;
			},
		);
	}
}
