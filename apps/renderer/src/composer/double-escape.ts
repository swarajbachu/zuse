/** How long the "press Esc again to clear" confirmation stays armed. */
export const CLEAR_CONFIRM_MS = 1500;

/** Require two deliberate presses in the same editor state. */
export class DoubleEscape {
	private first: { at: number; doc: unknown } | null = null;
	constructor(private readonly windowMs = 500) {}
	reset(): void {
		this.first = null;
	}
	press(doc: unknown, now = Date.now()): boolean {
		const previous = this.first;
		if (
			previous &&
			previous.doc === doc &&
			now - previous.at >= 0 &&
			now - previous.at <= this.windowMs
		) {
			this.reset();
			return true;
		}
		this.first = { at: now, doc };
		return false;
	}
}
