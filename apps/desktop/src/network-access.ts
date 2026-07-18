import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";

import type { NetworkAccessMode, NetworkAccessState } from "@zuse/contracts";

const PREFERENCE_FILE = "network-access.json";
const LOOPBACK_HOST = "127.0.0.1";
const NETWORK_BIND_HOST = "0.0.0.0";

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export type ResolvedNetworkAccessState = NetworkAccessState & {
	readonly bindHost: string;
};

const preferencePath = (userData: string): string =>
	join(userData, PREFERENCE_FILE);

const firstReachableIpv4 = (interfaces: NetworkInterfaces): string | null => {
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			if (
				entry.family === "IPv4" &&
				!entry.internal &&
				!entry.address.startsWith("169.254.")
			) {
				return entry.address;
			}
		}
	}
	return null;
};

export const resolveNetworkAccessState = (input: {
	readonly enabled: boolean;
	readonly port: number;
	readonly interfaces: NetworkInterfaces;
	readonly stableHost?: string | null;
}): ResolvedNetworkAccessState => {
	const mode: NetworkAccessMode = input.enabled
		? "network-accessible"
		: "local-only";
	if (!input.enabled) {
		return {
			mode,
			bindHost: LOOPBACK_HOST,
			advertisedHost: null,
			endpointUrl: null,
			port: input.port,
		};
	}

	const reachableAddress = firstReachableIpv4(input.interfaces);
	if (reachableAddress === null) {
		throw new Error(
			"No reachable local network address is available. Connect this computer to a network and try again.",
		);
	}
	const stableHost = input.stableHost?.trim();
	const advertisedHost = stableHost ? stableHost : reachableAddress;

	return {
		mode,
		bindHost: NETWORK_BIND_HOST,
		advertisedHost,
		endpointUrl: `ws://${advertisedHost}:${input.port}`,
		port: input.port,
	};
};

export const readNetworkAccessPreference = async (
	userData: string,
): Promise<boolean> => {
	try {
		const raw = JSON.parse(
			await readFile(preferencePath(userData), "utf8"),
		) as {
			enabled?: unknown;
		};
		return raw.enabled === true;
	} catch {
		return false;
	}
};

export const writeNetworkAccessPreference = async (
	userData: string,
	enabled: boolean,
): Promise<void> => {
	await mkdir(userData, { recursive: true });
	const destination = preferencePath(userData);
	const temporary = `${destination}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, destination);
};
