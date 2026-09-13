import { choosePreferredEndpoint } from "@zuse/client-runtime/endpoint-selection";
import {
	type ApiConnectGrant,
	type EnvironmentEndpoint,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";

const probePrivateEndpoint = async (
	endpoint: EnvironmentEndpoint,
): Promise<boolean> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1_200);
	try {
		const health = new URL("/healthz", endpoint.httpBaseUrl).toString();
		const response = await fetch(health, { signal: controller.signal });
		if (!response.ok) return false;
		const body = (await response.json()) as {
			readonly status?: unknown;
			readonly wireProtocolVersion?: unknown;
		};
		return (
			body.status === "ok" && body.wireProtocolVersion === WIRE_PROTOCOL_VERSION
		);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
};

export const chooseGrantEndpoint = async (
	grant: ApiConnectGrant,
): Promise<EnvironmentEndpoint> =>
	choosePreferredEndpoint(grant, (endpoint) => probePrivateEndpoint(endpoint));
