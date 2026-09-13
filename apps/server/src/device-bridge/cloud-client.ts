import type { DeviceCommandClient } from "@zuse/agents/drivers/device-command-tools";
import { type DeviceBridgeAction, DeviceBridgeResult } from "@zuse/contracts";
import { Schema } from "effect";

/** Keeps command leases alive independently of tool polling, while the runtime lives. */
export class CloudDeviceCommandClient implements DeviceCommandClient {
	private readonly active = new Set<string>();
	private readonly timer: ReturnType<typeof setInterval>;
	private polling = false;
	private closed = false;
	constructor(
		private readonly url: string,
		private readonly credential: () => string,
	) {
		this.timer = setInterval(() => {
			void this.heartbeat();
		}, 3000);
		this.timer.unref();
	}
	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		this.active.clear();
	}
	private async heartbeat(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			await Promise.allSettled(
				[...this.active].map((id) =>
					this.request({ _tag: "lease", id }).catch(() => {
						this.active.delete(id);
					}),
				),
			);
		} finally {
			this.polling = false;
		}
	}
	async request(action: DeviceBridgeAction): Promise<DeviceBridgeResult> {
		if (this.closed) throw new Error("Local command connection is closed");
		try {
			return await this.send(action);
		} catch (cause) {
			if (action._tag === "execute")
				throw new Error(
					`Local command ${action.input.id} has an unknown outcome. It may have been accepted. Use local_command_status with this ID and inspect any effects before issuing another command.`,
					{ cause },
				);
			throw cause;
		}
	}
	private async send(action: DeviceBridgeAction): Promise<DeviceBridgeResult> {
		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.credential()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ action }),
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok)
			throw new Error(
				`Local computer unavailable or access rejected (${response.status}). Check Devices settings. Execution is never automatically retried.`,
			);
		const result = Schema.decodeUnknownSync(DeviceBridgeResult)(
			await response.json(),
		);
		if (!this.closed && "state" in result) {
			if (result.state === "pending" || result.state === "running")
				this.active.add(result.id);
			else this.active.delete(result.id);
		}
		return result;
	}
}
