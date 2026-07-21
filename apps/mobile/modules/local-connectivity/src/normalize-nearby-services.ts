export type NearbyService = {
	readonly id: string;
	readonly routeId: string;
	readonly name: string;
	readonly type: string;
	readonly domain: string;
	readonly interfaceName?: string;
	readonly trustRecordId?: string;
	readonly tlsCertificatePin: string;
};

type NativeNearbyService = Omit<
	NearbyService,
	"routeId" | "interfaceName" | "trustRecordId"
> & {
	readonly interfaceName?: string | null;
	readonly trustRecordId?: string | null;
};

const optionalString = (
	value: string | null | undefined,
): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const routePriority = (service: NearbyService): number =>
	service.interfaceName?.startsWith("awdl") === true ? 1 : 0;

/**
 * Native browsing can report one Mac once per network route. The certificate
 * pin is the pre-pairing cryptographic device identity; names and addresses
 * are intentionally not used to decide whether two results are the same Mac.
 */
export const normalizeNearbyServices = (
	services: readonly NativeNearbyService[],
): readonly NearbyService[] => {
	const byCertificate = new Map<string, NearbyService>();
	for (const raw of services) {
		if (raw.tlsCertificatePin.length === 0) continue;
		const interfaceName = optionalString(raw.interfaceName);
		const trustRecordId = optionalString(raw.trustRecordId);
		const service: NearbyService = {
			id: raw.tlsCertificatePin,
			routeId: raw.id,
			name: raw.name,
			type: raw.type,
			domain: raw.domain,
			tlsCertificatePin: raw.tlsCertificatePin,
			...(interfaceName === undefined ? {} : { interfaceName }),
			...(trustRecordId === undefined ? {} : { trustRecordId }),
		};
		const current = byCertificate.get(service.tlsCertificatePin);
		if (
			current === undefined ||
			routePriority(service) < routePriority(current)
		) {
			byCertificate.set(service.tlsCertificatePin, service);
		}
	}
	return [...byCertificate.values()];
};

export const nearbyMacDisplayName = (name: string): string => {
	const withoutLocal = name.replace(/\.local(?: \(\d+\))?$/i, "");
	return withoutLocal.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
};
