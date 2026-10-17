import type { ApiConnectGrant, EnvironmentEndpoint } from "@zuse/contracts";

export const grantRouteEndpoints = (
	grant: ApiConnectGrant,
	secureOnly = false,
): readonly EnvironmentEndpoint[] => {
	const candidates = [
		...(grant.endpointCandidates ?? [])
			.filter((candidate) => candidate.kind === "private-network")
			.map((candidate) => candidate.endpoint),
		...(grant.endpointCandidates ?? [])
			.filter((candidate) => candidate.kind === "managed-tunnel")
			.map((candidate) => candidate.endpoint),
		grant.endpoint,
	];
	return [
		...new Map(
			candidates
				.filter((endpoint) => {
					try {
						const url = new URL(endpoint.wsBaseUrl);
						if (
							url.username ||
							url.password ||
							url.hostname === "localhost" ||
							url.hostname.endsWith(".localhost") ||
							url.hostname === "[::1]" ||
							/^127\./u.test(url.hostname)
						)
							return false;
						return secureOnly
							? url.protocol === "wss:"
							: url.protocol === "ws:" || url.protocol === "wss:";
					} catch {
						return false;
					}
				})
				.map((endpoint) => [endpoint.wsBaseUrl, endpoint]),
		).values(),
	];
};

/** Race authenticated sessions, not health checks; dispose losing transports. */
export const raceConnectionRoutes = <
	Route,
	Session extends { dispose: () => Promise<void> },
>(
	routes: readonly Route[],
	connect: (route: Route, signal: AbortSignal) => Promise<Session>,
	options: { staggerMs?: number; timeoutMs?: number } = {},
): Promise<{ route: Route; session: Session }> => {
	if (!routes.length)
		return Promise.reject(
			new Error(
				"No usable connection route. Enable Zuse Serve, Tailscale HTTPS, or a reachable local route.",
			),
		);
	return new Promise((resolve, reject) => {
		const controllers = routes.map(() => new AbortController());
		const timers: ReturnType<typeof setTimeout>[] = [];
		let settled = false;
		let failures = 0;
		const errors: unknown[] = [];
		const finish = () => {
			for (const timer of timers) clearTimeout(timer);
		};
		const fail = (index: number, cause: unknown) => {
			if (settled || errors[index] !== undefined) return;
			errors[index] = cause ?? new Error("Connection failed");
			failures++;
			if (failures === routes.length) {
				settled = true;
				finish();
				reject(errors[0]);
			}
		};
		routes.forEach((route, index) => {
			timers.push(
				setTimeout(
					() => {
						if (settled) return;
						const controller = controllers[index];
						if (!controller) return;
						const deadline = setTimeout(() => {
							controller.abort();
							fail(index, new Error("Connection route timed out"));
						}, options.timeoutMs ?? 8000);
						timers.push(deadline);
						void Promise.resolve()
							.then(() => {
								if (controller.signal.aborted)
									throw new Error("Route attempt cancelled");
								return connect(route, controller.signal);
							})
							.then(
								(session) => {
									clearTimeout(deadline);
									if (settled || controller.signal.aborted) {
										void session.dispose().catch(() => undefined);
										return;
									}
									settled = true;
									finish();
									controllers.forEach((other, otherIndex) => {
										if (otherIndex !== index) other.abort();
									});
									resolve({ route, session });
								},
								(cause) => {
									clearTimeout(deadline);
									fail(index, cause);
								},
							);
					},
					index * (options.staggerMs ?? 150),
				),
			);
		});
	});
};
