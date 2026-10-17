import type { SimulatorSession, SimulatorSummary } from "@zuse/contracts";

/** A first snapshot is a baseline; a new open event can reveal a dismissed viewer. */
export class SimulatorSessionReveal {
	private baseline = false;
	private known = new Map<string, number>();
	update(
		sessions: readonly SimulatorSession[],
		devices: readonly SimulatorSummary[],
	): SimulatorSession[] {
		const available = new Set(devices.map((device) => device.id));
		const eligible = sessions.filter((session) =>
			available.has(session.deviceId),
		);
		const opened = this.baseline
			? eligible.filter(
					(session) => this.known.get(session.deviceId) !== session.openedAt,
				)
			: [];
		const current = new Set(sessions.map((session) => session.deviceId));
		const next = new Map(
			[...this.known].filter(([deviceId]) => current.has(deviceId)),
		);
		for (const session of this.baseline ? eligible : sessions)
			next.set(session.deviceId, session.openedAt);
		this.baseline = true;
		this.known = next;
		return opened;
	}
}
