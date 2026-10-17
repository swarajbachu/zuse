import { isPrivateOrLocalHost } from "@zuse/contracts";

export { groupHostedComputers } from "@zuse/client-runtime/remote-computer-catalog";

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

		return {
			kind,
			address: `${url.origin}${url.pathname.replace(/\/$/, "")}`,
		} as const;
	} catch {
		return null;
	}
}
