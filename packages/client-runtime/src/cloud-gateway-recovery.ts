import { WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE } from "@zuse/contracts";

/** Cloudflare can mask an immediate private close with browser code 1006.
 * Recover before the first handshake; allow one ordinary flap after it. */
export const cloudGatewayCloseRecovery = (
	code: number,
	wasHealthy: boolean,
	previousAbnormalCloses: number,
) => {
	const abnormalCloses = code === 1006 ? previousAbnormalCloses + 1 : 0;
	return {
		abnormalCloses,
		recover:
			code === WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code ||
			(code === 1006 && !wasHealthy) ||
			abnormalCloses >= 2,
	};
};
