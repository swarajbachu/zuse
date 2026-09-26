import {
	type ApiEnvironmentRecord,
	isPrivateOrLocalHost,
} from "@zuse/contracts";

/** Names and addresses are not identities: many computers advertise localhost. */
function identity(computer: ApiEnvironmentRecord): string {
	try {
		const key = JSON.parse(computer.environmentPublicKey ?? "null");
		const parts =
			key?.kty === "EC"
				? [key.kty, key.crv, key.x, key.y]
				: key?.kty === "OKP"
					? [key.kty, key.crv, key.x]
					: key?.kty === "RSA"
						? [key.kty, key.n, key.e]
						: [];
		if (
			parts.length &&
			parts.every((part) => typeof part === "string" && part.length > 0)
		)
			return JSON.stringify(parts);
	} catch {
		/* Older registrations may have no usable public key. */
	}
	return `id:${computer.environmentId}`;
}

export function groupHostedComputers(
	computers: ReadonlyArray<ApiEnvironmentRecord>,
) {
	const groups = new Map<string, ApiEnvironmentRecord[]>();
	for (const computer of computers) {
		if (computer.providerKind === "cloud") continue;
		const key = identity(computer);
		const group = groups.get(key) ?? [];
		if (!group.some((entry) => entry.environmentId === computer.environmentId))
			group.push(computer);
		groups.set(key, group);
	}
	return [...groups.values()].flatMap((registrations) => {
		registrations.sort(
			(a, b) =>
				(b.lastHeartbeat ?? b.linkedAt) - (a.lastHeartbeat ?? a.linkedAt),
		);
		const computer = registrations[0];
		return computer ? [{ computer, registrations }] : [];
	});
}

export function hostedComputerAddress(address: string) {
	try {
		const url = new URL(address);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		const host = url.hostname.toLowerCase().replace(/\.$/, "");
		const kind =
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host === "[::1]" ||
			/^127\./.test(host)
				? "localhost"
				: host.endsWith(".ts.net")
					? "tailscale"
					: isPrivateOrLocalHost(host)
						? "lan"
						: "remote";
		// Never display credentials, query strings or fragments from advertised URLs.
		return {
			kind,
			address: `${url.origin}${url.pathname.replace(/\/$/, "")}`,
		} as const;
	} catch {
		return null;
	}
}
