const DEFAULT_PAIRING_TIMEOUT_MS = 10_000;

export const redeemPairingCode = async (options: {
	host: string;
	port: number;
	code: string;
	deviceId: string;
	deviceLabel: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<string> => {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
	);
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(
			`http://${options.host}:${options.port}/pair`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					code: options.code,
					deviceId: options.deviceId,
					deviceLabel: options.deviceLabel,
				}),
				signal: controller.signal,
			},
		);
	} catch (cause) {
		if (controller.signal.aborted) {
			throw new Error(
				"The desktop did not respond. Check that both devices are on the same Wi-Fi, then try again.",
			);
		}
		throw new Error(
			"Could not reach the desktop. Check that both devices are on the same Wi-Fi, then try again.",
			{ cause },
		);
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: string;
		} | null;
		if (response.status === 410 || body?.error === "expired_code") {
			throw new Error(
				"This pairing code expired. Generate a new code on the desktop.",
			);
		}
		if (response.status === 401 || body?.error === "invalid_code") {
			throw new Error("This pairing code is invalid or has already been used.");
		}
		throw new Error(
			"Could not pair with the desktop. Check that both devices are on the same Wi-Fi.",
		);
	}
	const body = (await response.json()) as { token?: string };
	if (typeof body.token !== "string" || !body.token.startsWith("zt_")) {
		throw new Error("Pairing response did not include a bearer token");
	}
	return body.token;
};
