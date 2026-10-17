import type { BridgeDevice, DeviceBridgeResult } from "@zuse/contracts";
export interface BridgeCatalogView {
	readonly devices: readonly BridgeDevice[];
	readonly selected: string;
	readonly busy: boolean;
	readonly error: string | null;
}
export const EMPTY_BRIDGE_CATALOG: BridgeCatalogView = {
	devices: [],
	selected: "",
	busy: false,
	error: null,
};
/** Account discovery for cloud commands; deliberately independent from remote environments. */
export class DeviceBridgeCatalogController {
	private view = EMPTY_BRIDGE_CATALOG;
	private generation = 0;
	private revision = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private listener: ((view: BridgeCatalogView) => void) | undefined;
	constructor(
		private readonly deps: {
			list: () => Promise<readonly BridgeDevice[]>;
			status: () => Promise<DeviceBridgeResult>;
			select: (deviceId: string) => Promise<unknown>;
		},
	) {}
	private publish(patch: Partial<BridgeCatalogView>, generation: number) {
		if (generation !== this.generation || !this.listener) return;
		this.view = { ...this.view, ...patch };
		this.listener(this.view);
	}
	start(listener: (view: BridgeCatalogView) => void) {
		const generation = ++this.generation;
		this.listener = listener;
		this.view = EMPTY_BRIDGE_CATALOG;
		listener(this.view);
		const refresh = async () => {
			if (!this.view.busy) {
				const revision = this.revision;
				try {
					const [devices, status] = await Promise.all([
						this.deps.list(),
						this.deps.status().catch(() => null),
					]);
					if (!this.view.busy && revision === this.revision)
						this.publish(
							{
								devices,
								selected:
									status && "deviceId" in status
										? status.deviceId
										: this.view.selected,
								error: null,
							},
							generation,
						);
				} catch {
					if (revision === this.revision && !this.view.busy)
						this.publish({ error: "Couldn’t load cloud devices" }, generation);
				}
			}
			if (generation === this.generation)
				this.timer = setTimeout(() => void refresh(), 15000);
		};
		void refresh();
		return () => {
			this.generation++;
			this.listener = undefined;
			clearTimeout(this.timer);
		};
	}
	async select(deviceId: string) {
		if (!this.listener || this.view.busy) return;
		const generation = this.generation;
		this.revision++;
		this.publish({ busy: true, error: null }, generation);
		try {
			await this.deps.select(deviceId);
			this.publish({ selected: deviceId }, generation);
		} catch {
			this.publish(
				{
					error:
						"Couldn’t select this device. Refresh to check its connection.",
				},
				generation,
			);
		} finally {
			this.publish({ busy: false }, generation);
		}
	}
}
