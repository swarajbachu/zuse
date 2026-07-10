export class ReadinessBarrier {
	private ready = false;
	private resolve!: () => void;
	private readonly promise = new Promise<void>((resolve) => {
		this.resolve = resolve;
	});

	get isReady(): boolean {
		return this.ready;
	}

	open(): void {
		if (this.ready) return;
		this.ready = true;
		this.resolve();
	}

	wait(): Promise<void> {
		return this.promise;
	}
}
