import type { EnvironmentEndpoint, RelayConnectGrant } from "@zuse/contracts";

export const choosePreferredEndpoint = async (
	grant: RelayConnectGrant,
	probePrivateEndpoint: (
		endpoint: EnvironmentEndpoint,
		token: string,
	) => Promise<boolean>,
): Promise<EnvironmentEndpoint> => {
	const privateEndpoint = grant.endpointCandidates?.find(
		(candidate) => candidate.kind === "private-network",
	)?.endpoint;
	if (
		privateEndpoint !== undefined &&
		(await probePrivateEndpoint(privateEndpoint, grant.connectToken))
	) {
		return privateEndpoint;
	}
	return (
		grant.endpointCandidates?.find(
			(candidate) => candidate.kind === "managed-tunnel",
		)?.endpoint ?? grant.endpoint
	);
};
