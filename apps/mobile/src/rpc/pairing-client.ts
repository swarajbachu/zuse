import { isPrivateOrLocalHost } from "@zuse/contracts";
import { fetch as expoFetch } from "expo/fetch";

const DEFAULT_PAIRING_TIMEOUT_MS = 10_000;

export const redeemPairingCode = async (options: {
	host: string;
	port: number;
	code: string;
	deviceId: string;
	deviceLabel: string;
	httpBaseUrl?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<{
	readonly token: string;
	readonly environmentId?: string;
	readonly environmentPublicKey?: string;
	readonly transportCertificatePin?: string;
}> => {
	let baseUrl: URL;
	try {
		const host = options.host.trim();
		const address =
			host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		baseUrl = new URL(
			options.httpBaseUrl ?? `http://${address}:${options.port}`,
		);
		// Direct LAN pairing is supported on trusted networks; it is not TLS.
		const localHttp =
			baseUrl.protocol === "http:" && isPrivateOrLocalHost(baseUrl.hostname);
		if (
			(baseUrl.protocol !== "https:" && !localHttp) ||
			baseUrl.username ||
			baseUrl.password ||
			baseUrl.search ||
			baseUrl.hash
		) {
			throw new Error("Invalid pairing endpoint");
		}
	} catch {
		throw new Error(
			"Pairing requires HTTPS or a private/local HTTP address. Use HTTPS for public servers and only use local HTTP on a trusted network.",
		);
	}
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
	);
	let response: Response;
	try {
		response = await (options.fetchImpl ?? expoFetch)(
			`${baseUrl.href.replace(/\/$/u, "")}/pair`,
			{
				method: "POST",
				redirect: "error",
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
				"The computer did not respond. Check that both devices can reach the same private network, then try again.",
			);
		}
		throw new Error(
			"Could not reach the computer. Check that both devices can reach the same private network, then try again.",
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
			"Could not pair with the computer. Check the private-network connection and try again.",
		);
	}
	const body = (await response.json()) as {
		token?: string;
		environmentId?: string;
		environmentPublicKey?: string;
		transportCertificatePin?: string;
	};
	if (typeof body.token !== "string" || !body.token.startsWith("zt_")) {
		throw new Error("Pairing response did not include a bearer token");
	}
	return { ...body, token: body.token };
};
