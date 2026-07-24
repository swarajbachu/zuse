/**
 * Verify the server through the same multiplexing native proxy that the
 * application WebSocket will use. Re-resolving a Bonjour service between
 * verification and connection can otherwise select a stale publication.
 */
export const openVerifiedLocalRoute = async <Service, Proxy>(input: {
	readonly service: Service;
	readonly open: (service: Service) => Promise<Proxy>;
	readonly close: (proxy: Proxy) => Promise<void>;
	readonly verify: (proxy: Proxy) => Promise<void>;
}): Promise<Proxy> => {
	const verificationProxy = await input.open(input.service);
	try {
		await input.verify(verificationProxy);
		return verificationProxy;
	} catch (cause) {
		await input.close(verificationProxy);
		throw cause;
	}
};

export const hasCurrentLocalRoute = (
	currentRouteId: string | undefined,
	candidates: readonly { readonly routeId: string }[],
): boolean =>
	currentRouteId !== undefined &&
	candidates.some((candidate) => candidate.routeId === currentRouteId);
