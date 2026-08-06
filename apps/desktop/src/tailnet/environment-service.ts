import { createHash } from "node:crypto";
import { hostname } from "node:os";

import {
	type EnsureTailnetEnvironmentInput,
	EnvironmentDescriptor,
	EnvironmentId,
	TailnetEnvironmentConnection,
	TailnetEnvironmentProfile,
} from "@zuse/contracts";
import keytar from "keytar";

import { TailnetEnvironmentProfileStore } from "./profile-store.ts";

const CREDENTIAL_SERVICE = "sh.zuse.tailnet-environment";

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
	const outer = new URL(value.trim());
	if (outer.protocol !== "zuse:") {
		throw new Error("Paste a Zuse pairing link from the other computer.");
	}
	const endpointValue = outer.searchParams.get("pairingUrl");
	const code = outer.hash.startsWith("#token=")
		? decodeURIComponent(outer.hash.slice("#token=".length))
		: "";
	if (endpointValue === null || code.length === 0) {
		throw new Error("This pairing link is incomplete or expired.");
	}
	const endpoint = new URL(endpointValue);
	if (endpoint.protocol !== "wss:") {
		throw new Error("Tailnet pairing requires a secure wss:// endpoint.");
	}
	if (
		!endpoint.hostname.endsWith(".ts.net") ||
		endpoint.username.length > 0 ||
		endpoint.password.length > 0
	) {
		throw new Error("This is not a valid Tailscale device address.");
	}
	return {
		code,
		httpBaseUrl: `https://${endpoint.host}`,
		wsBaseUrl:
			endpoint.pathname === "/" || endpoint.pathname.length === 0
				? `wss://${endpoint.host}/rpc`
				: endpoint.toString().replace(/\/$/u, ""),
	};
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
		const response = await this.fetcher(`${parsed.httpBaseUrl}/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: parsed.code,
				deviceId: profileId,
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
					: "The Tailnet computer could not complete pairing.",
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
