import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import {
	type EnsureTailnetEnvironmentInput,
	EnvironmentDescriptor,
	EnvironmentId,
	parseConnectLink,
	TailnetEnvironmentConnection,
	TailnetEnvironmentProfile,
} from "@zuse/contracts";
import keytar from "keytar";

import { TailnetEnvironmentProfileStore } from "./profile-store.ts";

const CREDENTIAL_SERVICE = "sh.zuse.tailnet-environment";
const CLIENT_ID_FILE = "tailnet-client-id";

const readOrCreateClientId = async (userData: string): Promise<string> => {
	const destination = join(userData, CLIENT_ID_FILE);
	try {
		const existing = (await readFile(destination, "utf8")).trim();
		if (existing.length > 0 && existing.length <= 128) {
			await chmod(destination, 0o600);
			return existing;
		}
	} catch (cause) {
		if (
			typeof cause !== "object" ||
			cause === null ||
			!("code" in cause) ||
			cause.code !== "ENOENT"
		) {
			throw cause;
		}
	}
	await mkdir(userData, { recursive: true, mode: 0o700 });
	const clientId = `desktop_${randomUUID()}`;
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${clientId}\n`, {
		mode: 0o600,
		encoding: "utf8",
	});
	try {
		await rename(temporary, destination);
		await chmod(destination, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
	return clientId;
};

export type CredentialVault = {
	readonly get: (profileId: string) => Promise<string | null>;
	readonly set: (profileId: string, token: string) => Promise<void>;
	readonly remove: (profileId: string) => Promise<void>;
};

const defaultVault: CredentialVault = {
	get: (profileId) => keytar.getPassword(CREDENTIAL_SERVICE, profileId),
	set: async (profileId, token) => {
		await keytar.setPassword(CREDENTIAL_SERVICE, profileId, token);
	},
	remove: async (profileId) => {
		await keytar.deletePassword(CREDENTIAL_SERVICE, profileId);
	},
};

export type ParsedTailnetPairingLink = {
	readonly code: string;
	readonly httpBaseUrl: string;
	readonly wsBaseUrl: string;
};

export const parseTailnetPairingLink = (
	value: string,
): ParsedTailnetPairingLink => {
	const parsed = parseConnectLink(value);
	if (parsed.ok) {
		return {
			code: parsed.link.code,
			httpBaseUrl: parsed.link.httpBaseUrl,
			wsBaseUrl: parsed.link.wsBaseUrl,
		};
	}
	if (parsed.reason === "incomplete") {
		throw new Error("This pairing link is incomplete or expired.");
	}
	if (parsed.reason === "insecure-endpoint") {
		throw new Error(
			"Public connect links must use a secure wss:// address. Plaintext links are allowed only on a private local network.",
		);
	}
	if (parsed.reason === "wrong-scheme" || parsed.reason === "unrecognized") {
		throw new Error("Paste a Zuse pairing link from the other computer.");
	}
	throw new Error("This link doesn't point to a reachable Zuse computer.");
};

const profileIdFor = (httpBaseUrl: string): string =>
	`tailnet_${createHash("sha256").update(httpBaseUrl).digest("hex").slice(0, 24)}`;

const wsUrlWithToken = (wsBaseUrl: string, token: string): string => {
	const url = new URL(wsBaseUrl);
	url.searchParams.set("token", token);
	return url.toString();
};

export class TailnetEnvironmentManager {
	private readonly profiles: TailnetEnvironmentProfileStore;
	private readonly clientId: Promise<string>;
	private readonly pending = new Map<
		string,
		{ readonly profile: TailnetEnvironmentProfile; readonly token: string }
	>();

	constructor(
		userData: string,
		private readonly vault: CredentialVault = defaultVault,
		private readonly fetcher: typeof fetch = fetch,
	) {
		this.profiles = new TailnetEnvironmentProfileStore(userData);
		this.clientId = readOrCreateClientId(userData);
	}

	initialize(): Promise<ReadonlyArray<TailnetEnvironmentProfile>> {
		return this.profiles.load();
	}

	listProfiles(): ReadonlyArray<TailnetEnvironmentProfile> {
		return this.profiles.list();
	}

	async ensure(
		input: EnsureTailnetEnvironmentInput,
	): Promise<TailnetEnvironmentConnection> {
		if ("profileId" in input) {
			const pending = this.pending.get(input.profileId);
			if (pending !== undefined) {
				return this.connection(pending.profile, pending.token);
			}
			const profile = this.profiles.get(input.profileId);
			if (profile === null)
				throw new Error("Saved Tailnet computer was not found.");
			const token = await this.vault.get(profile.profileId);
			if (token === null) {
				throw new Error("Pair this Tailnet computer again to restore access.");
			}
			return this.connection(profile, token);
		}

		const parsed = parseTailnetPairingLink(input.pairingLink);
		const profileId = profileIdFor(parsed.httpBaseUrl);
		const deviceId = await this.clientId;
		const response = await this.fetcher(`${parsed.httpBaseUrl}/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: parsed.code,
				deviceId,
				deviceLabel: hostname(),
			}),
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await response.json().catch(() => ({}))) as {
			readonly token?: unknown;
			readonly environmentId?: unknown;
		};
		if (
			!response.ok ||
			typeof body.token !== "string" ||
			!body.token.startsWith("zt_") ||
			typeof body.environmentId !== "string"
		) {
			throw new Error(
				response.status === 401 || response.status === 410
					? "This pairing link expired. Create a new link on the other computer."
					: "The remote computer could not complete pairing.",
			);
		}
		const tailnetHostname = new URL(parsed.httpBaseUrl).hostname;
		const label =
			input.label?.trim() || tailnetHostname.split(".")[0] || tailnetHostname;
		const profile = TailnetEnvironmentProfile.make({
			profileId,
			environmentId: EnvironmentId.make(body.environmentId),
			label,
			httpBaseUrl: parsed.httpBaseUrl,
			wsBaseUrl: parsed.wsBaseUrl,
			lastConnectedAt: new Date().toISOString(),
		});
		this.pending.set(profileId, { profile, token: body.token });
		return this.connection(profile, body.token);
	}

	async confirmEnvironment(
		profileId: string,
		environmentId: string,
	): Promise<TailnetEnvironmentProfile> {
		const pending = this.pending.get(profileId);
		const current = pending?.profile ?? this.profiles.get(profileId);
		if (current === null || current === undefined) {
			throw new Error("Saved Tailnet computer was not found.");
		}
		if (current.environmentId !== environmentId) {
			this.pending.delete(profileId);
			throw new Error(
				"This Tailnet address belongs to a different Zuse computer.",
			);
		}
		const confirmed = TailnetEnvironmentProfile.make({
			...current,
			lastConnectedAt: new Date().toISOString(),
		});
		if (pending !== undefined) {
			await this.vault.set(profileId, pending.token);
			try {
				await this.profiles.put(confirmed);
			} catch (cause) {
				await this.vault.remove(profileId).catch(() => undefined);
				throw cause;
			}
			this.pending.delete(profileId);
		} else {
			await this.profiles.put(confirmed);
		}
		return confirmed;
	}

	async remove(profileId: string): Promise<void> {
		this.pending.delete(profileId);
		await this.profiles.remove(profileId);
		await this.vault.remove(profileId);
	}

	async updateLabel(
		profileId: string,
		label: string,
	): Promise<TailnetEnvironmentProfile> {
		const pending = this.pending.get(profileId);
		const current = pending?.profile ?? this.profiles.get(profileId);
		const normalized = label.trim();
		if (current === null)
			throw new Error("Saved Tailnet computer was not found.");
		if (normalized.length === 0) throw new Error("Computer label is required.");
		const profile = TailnetEnvironmentProfile.make({
			...current,
			label: normalized,
		});
		if (pending !== undefined) {
			this.pending.set(profileId, { ...pending, profile });
		} else {
			await this.profiles.put(profile);
		}
		return profile;
	}

	private connection(
		profile: TailnetEnvironmentProfile,
		token: string,
	): TailnetEnvironmentConnection {
		return TailnetEnvironmentConnection.make({
			profile,
			wsUrl: wsUrlWithToken(profile.wsBaseUrl, token),
			descriptor: EnvironmentDescriptor.make({
				environmentId: profile.environmentId,
				providerKind: "desktop",
				label: profile.label,
				endpoint: {
					httpBaseUrl: profile.httpBaseUrl,
					wsBaseUrl: profile.wsBaseUrl,
				},
			}),
		});
	}
}
