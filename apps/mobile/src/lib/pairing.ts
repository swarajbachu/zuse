import { parsePairingUrl } from "../offline/cache-utils";
import type { ConnectionRecord } from "./connection-records";

export type AddPairedConnection = (input: {
	readonly host: string;
	readonly port: number;
	readonly token: string;
	readonly source: "paired";
}) => Promise<ConnectionRecord>;

export const isLegacyPairingUrl = (value: string): boolean => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "zuse:" &&
			url.pathname !== "/connect/pair" &&
			url.searchParams.has("pairingUrl")
		);
	} catch {
		return false;
	}
};

export const pairWithDesktop = async (
	value: string,
	add: AddPairedConnection,
): Promise<ConnectionRecord> => {
	const parsed = parsePairingUrl(value);
	if (parsed.token === undefined || parsed.token.trim().length === 0) {
		throw new Error("This pairing code does not include a pairing token.");
	}
	return add({ ...parsed, token: parsed.token, source: "paired" });
};
