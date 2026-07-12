export type PushListener<A> = (event: A) => PromiseLike<void> | void;

export class OrderedPushBus<A> {
	private readonly listeners = new Set<PushListener<A>>();
	private tail: Promise<void> = Promise.resolve();

	subscribe(listener: PushListener<A>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(event: A): Promise<void> {
		const listeners = [...this.listeners];
		const published = this.tail.then(async () => {
			for (const listener of listeners) await listener(event);
		});
		this.tail = published.catch(() => undefined);
		return published;
	}

	drain(): Promise<void> {
		return this.tail;
	}
}
