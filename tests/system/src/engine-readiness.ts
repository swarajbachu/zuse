import { setTimeout as delay } from "node:timers/promises";
import { readEngineEndpoint } from "@zusehq/server/desktop-engine";

/** Renderer navigation is independent of engine startup. */
export const waitForEngineEndpoint = async (
	userData: string,
	timeoutMs = 30_000,
) => {
	const deadline = Date.now() + timeoutMs;
	do {
		const endpoint = await readEngineEndpoint(userData);
		if (endpoint !== null) return endpoint;
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(
		"Engine did not publish its endpoint before the startup deadline",
	);
};
