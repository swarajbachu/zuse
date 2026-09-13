/** One bounded mailbox per live session, including events emitted during start. */
export class ProviderEventHub {
	private readonly sessions = new Map<
		string,
		{
			values: unknown[];
			bytes: number;
			wake?: () => void;
			ended: boolean;
			subscribed: boolean;
		}
	>();
	open(id: string): void {
		if (this.sessions.has(id))
			throw new Error("Provider session already exists.");
		if (this.sessions.size >= 128)
			throw new Error("Too many extension provider sessions.");
		this.sessions.set(id, {
			values: [],
			bytes: 0,
			ended: false,
			subscribed: false,
		});
	}
	push(id: string, event: unknown): void {
		const queue = this.sessions.get(id);
		if (!queue || queue.ended) return;
		const bytes = Buffer.byteLength(JSON.stringify(event));
		if (queue.values.length >= 256 || queue.bytes + bytes > 2 * 1024 * 1024) {
			queue.values = [
				{
					_tag: "Error",
					message:
						"Extension event queue overflowed. Resume the conversation to recover.",
				},
				{ _tag: "Status", status: "error" },
			];
			queue.ended = true;
		} else {
			queue.values.push(event);
			queue.bytes += bytes;
			if (
				event &&
				typeof event === "object" &&
				"_tag" in event &&
				event._tag === "Status" &&
				"status" in event &&
				event.status === "error"
			)
				queue.ended = true;
		}
		queue.wake?.();
		queue.wake = undefined;
	}
	close(id: string): void {
		const queue = this.sessions.get(id);
		if (!queue) return;
		queue.ended = true;
		queue.wake?.();
		if (!queue.subscribed) this.sessions.delete(id);
	}
	stop(): void {
		for (const id of this.sessions.keys()) this.close(id);
	}
	async *stream(id: string): AsyncGenerator<unknown> {
		const queue = this.sessions.get(id);
		if (!queue || queue.subscribed)
			throw new Error("Provider event stream is unavailable.");
		queue.subscribed = true;
		try {
			while (true) {
				if (queue.values.length) {
					const event = queue.values.shift();
					queue.bytes = Math.max(
						0,
						queue.bytes - Buffer.byteLength(JSON.stringify(event)),
					);
					yield event;
				} else if (queue.ended) return;
				else
					await new Promise<void>((resolve) => {
						queue.wake = resolve;
					});
			}
		} finally {
			this.sessions.delete(id);
		}
	}
}
