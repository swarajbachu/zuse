import {
	type CiaoService,
	getResponder,
	type Responder,
} from "@homebridge/ciao";

/** AppImages must advertise without relying on distro-installed Avahi tools. */
export const createLinuxLocalConnectivity = (options: {
	readonly serviceName: string;
	readonly log: (event: string, fields?: Record<string, unknown>) => void;
}) => {
	let responder: Responder | undefined;
	let service: CiaoService | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	let stopped = false;
	let closing: Promise<void> | undefined;
	const advertise = () => {
		if (stopped || service === undefined) return;
		void service.advertise().then(
			() => {
				failures = 0;
				options.log("local.publisher.ready");
			},
			(cause: unknown) => {
				if (stopped) return;
				options.log("local.publisher.failed", {
					reason: cause instanceof Error ? cause.message : String(cause),
				});
				failures += 1;
				retry = setTimeout(
					advertise,
					Math.min(16_000, 1_000 * 2 ** (failures - 1)),
				);
				retry.unref();
			},
		);
	};
	return {
		start: (port: number, pin?: string): void => {
			if (stopped || responder !== undefined) return;
			responder = getResponder();
			service = responder.createService({
				name: options.serviceName,
				type: "zuse",
				port,
				txt: pin === undefined ? {} : { tls: pin },
			});
			service.on("name-change", (name: string) => {
				options.log("local.publisher.name_changed", { name });
			});
			advertise();
		},
		close: (): Promise<void> => {
			if (closing !== undefined) return closing;
			stopped = true;
			clearTimeout(retry);
			closing = responder?.shutdown() ?? Promise.resolve();
			return closing;
		},
	};
};
