export interface PowerMonitorEventSource {
	on(event: string, listener: () => void): unknown;
	off(event: string, listener: () => void): unknown;
}

export const installPowerMonitorEventSampling = (input: {
	readonly source: PowerMonitorEventSource;
	readonly sample: () => void;
	readonly includeThermalState: boolean;
}): (() => void) => {
	const events = [
		"on-ac",
		"on-battery",
		"suspend",
		"resume",
		...(input.includeThermalState ? ["thermal-state-change"] : []),
	];
	for (const event of events) input.source.on(event, input.sample);
	return () => {
		for (const event of events) input.source.off(event, input.sample);
	};
};
