export interface InteractiveProcess {
	readonly kill: () => void;
}

/** Owns the single local authorization process and its post-input deadline. */
export class InteractiveProcessRegistry<Process extends InteractiveProcess> {
	private current: {
		readonly sessionId: string;
		readonly process: Process;
	} | null = null;
	private timeout: ReturnType<typeof setTimeout> | null = null;

	replace(sessionId: string, process: Process): void {
		this.cancelCurrent();
		this.current = { sessionId, process };
	}

	get(sessionId: string): Process | undefined {
		return this.current?.sessionId === sessionId
			? this.current.process
			: undefined;
	}

	armTimeout(sessionId: string, delayMs: number): boolean {
		const process = this.get(sessionId);
		if (process === undefined) return false;
		this.clearTimeout();
		this.timeout = setTimeout(() => {
			this.timeout = null;
			this.cancel(sessionId, process);
		}, delayMs);
		return true;
	}

	release(sessionId: string, process: Process): boolean {
		if (
			this.current?.sessionId !== sessionId ||
			this.current.process !== process
		) {
			return false;
		}
		this.clearTimeout();
		this.current = null;
		return true;
	}

	cancel(sessionId: string, process?: Process): boolean {
		const current = this.get(sessionId);
		if (
			current === undefined ||
			(process !== undefined && current !== process)
		) {
			return false;
		}
		this.release(sessionId, current);
		try {
			current.kill();
		} catch {
			// It may have exited between lookup and cancellation.
		}
		return true;
	}

	private cancelCurrent(): void {
		if (this.current === null) return;
		this.cancel(this.current.sessionId, this.current.process);
	}

	private clearTimeout(): void {
		if (this.timeout !== null) clearTimeout(this.timeout);
		this.timeout = null;
	}
}
