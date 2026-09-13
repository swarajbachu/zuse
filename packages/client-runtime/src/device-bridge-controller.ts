import type {
	DeviceBridgeControl,
	DeviceBridgeResult,
	DeviceBridgeStatus,
} from "@zuse/contracts";
export interface DeviceBridgeView {
	readonly status: DeviceBridgeStatus | null;
	readonly busy: boolean;
	readonly error: string | null;
}
export const EMPTY_DEVICE_BRIDGE_VIEW: DeviceBridgeView = {
	status: null,
	busy: false,
	error: null,
};
/** Shared, bounded polling and mutation lifecycle for desktop, browser, and mobile. */
export class DeviceBridgeController {
	private view: DeviceBridgeView = EMPTY_DEVICE_BRIDGE_VIEW;
	private listener: ((view: DeviceBridgeView) => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private revision = 0;
	constructor(
		private readonly send: (
			action: DeviceBridgeControl,
		) => Promise<DeviceBridgeResult>,
	) {}
	start(listener: (view: DeviceBridgeView) => void): () => void {
		const generation = ++this.generation;
		this.listener = listener;
		this.view = EMPTY_DEVICE_BRIDGE_VIEW;
		listener(this.view);
		const poll = async () => {
			if (!this.view.busy) await this.refresh(generation);
			if (generation === this.generation)
				this.timer = setTimeout(
					() => {
						void poll();
					},
					this.view.status ? 3000 : 15000,
				);
		};
		void poll();
		return () => {
			this.generation++;
			this.listener = undefined;
			clearTimeout(this.timer);
		};
	}
	private publish(update: Partial<DeviceBridgeView>, generation: number): void {
		if (generation !== this.generation || !this.listener) return;
		this.view = { ...this.view, ...update };
		this.listener(this.view);
	}
	private async refresh(generation: number): Promise<void> {
		const revision = ++this.revision;
		try {
			const result = await this.send({ _tag: "status" });
			if (!("version" in result)) throw new Error("Invalid device status");
			if (revision === this.revision)
				this.publish({ status: result, error: null }, generation);
		} catch {
			if (revision !== this.revision) return;
			this.publish(
				{
					status: null,
					error:
						"Local computer unavailable. Check desktop Devices settings and runtime support.",
				},
				generation,
			);
		}
	}
	act(action: DeviceBridgeControl): Promise<void> {
		return this.run(() => this.send(action));
	}
	async run(task: () => Promise<unknown>): Promise<void> {
		if (this.view.busy || !this.listener) return;
		const generation = this.generation;
		this.revision++;
		this.publish({ busy: true, error: null }, generation);
		try {
			await task();
			await this.refresh(generation);
		} catch (cause) {
			this.publish(
				{
					error:
						cause instanceof Error && cause.message
							? cause.message
							: "Device request failed. Refresh and try again.",
				},
				generation,
			);
		} finally {
			this.publish({ busy: false }, generation);
		}
	}
}
