/** Require two deliberate presses in the same editor state. */
export class DoubleEscape {
	private first: { at: number; doc: unknown } | null = null;
	reset(): void {
		this.first = null;
	}
	press(doc: unknown, now = Date.now()): boolean {
		const previous = this.first;
		if (
			previous &&
			previous.doc === doc &&
			now - previous.at >= 0 &&
			now - previous.at <= 500
		) {
			this.reset();
			return true;
		}
		this.first = { at: now, doc };
		return false;
	}
}
