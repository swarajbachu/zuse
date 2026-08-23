export type OptionalDesktopService = "browserCookies" | "ssh" | "tailnet";

export type OptionalDesktopReadiness = Readonly<
	Record<OptionalDesktopService, Promise<void>>
>;

type OptionalDesktopTasks = Readonly<
	Record<OptionalDesktopService, () => Promise<void>>
>;

/**
 * Starts the user-visible/runtime-critical path first, then launches unrelated
 * native initialization concurrently. Each readiness promise remains
 * awaitable by its first real consumer, so faster boot does not create races.
 */
export const startOptionalServicesAfterCritical = <Critical>(
	startCritical: () => Critical,
	tasks: OptionalDesktopTasks,
	onFailure: (
		service: OptionalDesktopService,
		cause: unknown,
	) => void = () => {},
): Readonly<{
	critical: Critical;
	readiness: OptionalDesktopReadiness;
}> => {
	const critical = startCritical();
	const start = (service: OptionalDesktopService): Promise<void> => {
		let task: Promise<void>;
		try {
			task = Promise.resolve(tasks[service]());
		} catch (cause) {
			task = Promise.reject(cause);
		}
		const readiness = task.catch((cause) => {
			onFailure(service, cause);
			throw cause;
		});
		// Readiness is intentionally allowed to reject for consumers, but attaching
		// a passive observer prevents an optional service from becoming an unhandled
		// rejection when the user never opens that feature.
		void readiness.catch(() => undefined);
		return readiness;
	};
	return {
		critical,
		readiness: {
			ssh: start("ssh"),
			tailnet: start("tailnet"),
			browserCookies: start("browserCookies"),
		},
	};
};
