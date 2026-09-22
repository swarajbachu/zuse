/** Presentation only: authoritative messages and acknowledgements are never buffered. */
export class StreamingTextReveal {
	private target: string;
	private value: string;
	private startedAt = 0;
	private from = 0;
	private deadline = 0;
	constructor(text: string) {
		this.target = text;
		this.value = text;
	}
	get text() {
		return this.value;
	}
	get pending() {
		return this.value !== this.target;
	}
	update(text: string, now: number, animate: boolean): void {
		if (text === this.target && animate) return;
		const append = text.startsWith(this.target);
		this.target = text;
		// Replacements, initial/history loads, and very large pastes render directly.
		if (!animate || !append || text.length - this.value.length > 4000) {
			this.value = text;
			this.deadline = 0;
			return;
		}
		this.from = this.value.length;
		this.startedAt = now;
		// A continuous stream cannot push the oldest pending chunk back forever.
		this.deadline = this.deadline > now ? this.deadline : now + 120;
	}
	frame(now: number): string {
		if (!this.pending) return this.value;
		const progress = Math.min(
			1,
			Math.max(
				0,
				(now - this.startedAt) / Math.max(1, this.deadline - this.startedAt),
			),
		);
		let end =
			this.from + Math.floor((this.target.length - this.from) * progress);
		// Never expose half of a surrogate pair (emoji/CJK supplementary characters).
		if (
			end > 0 &&
			end < this.target.length &&
			/[\uD800-\uDBFF]/.test(this.target[end - 1] ?? "")
		)
			end--;
		this.value = this.target.slice(0, end);
		return this.value;
	}
}
