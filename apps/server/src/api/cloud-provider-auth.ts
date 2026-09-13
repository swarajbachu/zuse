import { mkdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type {
	CloudAuthProvider,
	ProviderGrantRefreshReason,
	SealedProviderGrant,
} from "@zuse/contracts";
import { ProviderGrantRequest } from "@zuse/contracts";
import { type CryptoKey, calculateJwkThumbprint, type JWK } from "jose";
import type { ProviderCredential } from "../provider/services/credentials-service.ts";
import { openCloudAuthGrant } from "./cloud-grant-crypto.ts";

const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const MINIMUM_GRANT_LIFETIME_MS = 60 * 1_000;
const GROK_EPHEMERAL_AUTH_PATH = `/dev/shm/zuse-provider-auth-${process.pid}/grok-auth.json`;

interface ProviderGrantPlaintext {
	readonly zuseAccountId: string;
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly keyThumbprint: string;
	readonly authorityIncarnationId: string;
	readonly authorityEpoch: number;
	readonly providerId: CloudAuthProvider;
	readonly method: "subscription" | "api-key" | "custom";
	readonly credentialKind: "api-key" | "oauth-token";
	readonly secret: string;
	readonly providerAccountId: string | null;
	readonly issuer: string | null;
	readonly issuedAt: number;
	readonly expiresAt: number;
}

export interface CloudProviderAuthInput {
	readonly zuseAccountId: string;
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly credentialPublicJwk: string;
	readonly credentialPrivateKey: CryptoKey;
	readonly issueGrant: (
		providerId: CloudAuthProvider,
		request: ProviderGrantRequest,
	) => Promise<SealedProviderGrant>;
	readonly onStatus?: (
		providerId: CloudAuthProvider,
		status: "ready" | "reconnecting" | "reconnect-required" | "update-required",
	) => void;
	readonly onRecovered?: (providerId: CloudAuthProvider) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const decodeGrantPlaintext = (value: unknown): ProviderGrantPlaintext => {
	if (!isRecord(value)) throw new Error("provider-auth-update-required");
	for (const field of [
		"zuseAccountId",
		"workspaceId",
		"keyThumbprint",
		"authorityIncarnationId",
		"providerId",
		"method",
		"credentialKind",
		"secret",
	] as const)
		if (typeof value[field] !== "string" || value[field].length === 0)
			throw new Error("provider-auth-update-required");
	for (const field of [
		"runtimeGeneration",
		"authorityEpoch",
		"issuedAt",
		"expiresAt",
	] as const)
		if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]))
			throw new Error("provider-auth-update-required");
	if (
		(value.providerAccountId !== null &&
			typeof value.providerAccountId !== "string") ||
		(value.issuer !== null && typeof value.issuer !== "string")
	)
		throw new Error("provider-auth-update-required");
	return value as unknown as ProviderGrantPlaintext;
};

const reasonOf = (cause: unknown): string => {
	if (isRecord(cause) && typeof cause.reason === "string") return cause.reason;
	return cause instanceof Error ? cause.message : "provider-auth-reconnecting";
};

type CachedGrant = {
	readonly credential: ProviderCredential;
	readonly providerAccountId: string | null;
	readonly issuer: string | null;
	readonly expiresAt: number;
};

/** Account-authority grants cached only in the cloud runtime process. */
export class CloudProviderAuth {
	private readonly cached = new Map<CloudAuthProvider, CachedGrant>();
	private readonly inFlight = new Map<
		CloudAuthProvider,
		Promise<ProviderCredential>
	>();
	private readonly proactiveTimers = new Map<
		CloudAuthProvider,
		NodeJS.Timeout
	>();
	private readonly recoveryTimers = new Map<
		CloudAuthProvider,
		NodeJS.Timeout
	>();
	private readonly recovering = new Set<CloudAuthProvider>();
	private grokBridge: Server | null = null;
	private readonly keyThumbprint: Promise<string>;

	constructor(private readonly input: CloudProviderAuthInput) {
		this.keyThumbprint = calculateJwkThumbprint(
			JSON.parse(input.credentialPublicJwk) as JWK,
		);
	}

	readonly resolve = (
		providerId: CloudAuthProvider,
		reason: ProviderGrantRefreshReason = "initial",
	): Promise<ProviderCredential> => {
		const cached = this.cached.get(providerId);
		if (
			reason !== "unauthorized" &&
			(reason !== "initial" || providerId === "grok") &&
			cached !== undefined &&
			cached.expiresAt > Date.now() + PROACTIVE_REFRESH_WINDOW_MS
		)
			return Promise.resolve(cached.credential);
		const current = this.inFlight.get(providerId);
		if (current !== undefined) return current;
		this.input.onStatus?.(providerId, "reconnecting");
		const refresh = this.refresh(providerId, reason).finally(() => {
			this.inFlight.delete(providerId);
		});
		this.inFlight.set(providerId, refresh);
		return refresh;
	};

	async startGrokBridge(): Promise<void> {
		if (this.grokBridge !== null) return;
		await mkdir(`/dev/shm/zuse-provider-auth-${process.pid}`, {
			recursive: true,
			mode: 0o700,
		});
		await unlink(GROK_EPHEMERAL_AUTH_PATH).catch(() => undefined);
		const bearer = crypto.randomUUID();
		const server = createServer((request, response) => {
			if (
				request.method !== "GET" ||
				request.headers.authorization !== `Bearer ${bearer}`
			) {
				response.writeHead(404).end();
				return;
			}
			const reason = request.url?.includes("reason=unauthorized")
				? "unauthorized"
				: "initial";
			void this.grokToken(reason).then(
				(body) =>
					response
						.writeHead(200, { "content-type": "application/json" })
						.end(body),
				() => response.writeHead(503).end(),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") {
			server.close();
			throw new Error("grok-auth-update-required");
		}
		this.grokBridge = server;
		process.env.GROK_AUTH_PROVIDER_LABEL = "Zuse Cloud";
		process.env.GROK_AUTH_PATH = GROK_EPHEMERAL_AUTH_PATH;
		process.env.GROK_AUTH_PROVIDER_COMMAND =
			`if [ "\${GROK_AUTH_EXPIRED:-0}" = 1 ]; then r=unauthorized; else r=initial; fi; ` +
			`curl -fsS -H 'Authorization: Bearer ${bearer}' 'http://127.0.0.1:${address.port}/token?reason='"$r"`;
	}

	close(): void {
		for (const timer of this.proactiveTimers.values()) clearTimeout(timer);
		for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
		this.proactiveTimers.clear();
		this.recoveryTimers.clear();
		this.recovering.clear();
		this.cached.clear();
		this.inFlight.clear();
		if (this.grokBridge !== null) this.grokBridge.close();
		this.grokBridge = null;
		delete process.env.GROK_AUTH_PROVIDER_COMMAND;
		delete process.env.GROK_AUTH_PROVIDER_LABEL;
		delete process.env.GROK_AUTH_PATH;
		void unlink(GROK_EPHEMERAL_AUTH_PATH).catch(() => undefined);
	}

	private async grokToken(reason: ProviderGrantRefreshReason): Promise<string> {
		const credential = await this.resolve("grok", reason);
		if (credential.kind !== "oauth-token")
			throw new Error("grok-auth-update-required");
		const grant = this.cached.get("grok");
		if (grant === undefined) throw new Error("grok-auth-reconnecting");
		return JSON.stringify({
			access_token: credential.secret,
			expires_in: Math.max(
				60,
				Math.floor((grant.expiresAt - Date.now()) / 1_000),
			),
			issuer: grant.issuer ?? "https://auth.x.ai",
		});
	}

	private async refresh(
		providerId: CloudAuthProvider,
		reason: ProviderGrantRefreshReason,
	): Promise<ProviderCredential> {
		try {
			const keyThumbprint = await this.keyThumbprint;
			const requestId = crypto.randomUUID();
			const previousProviderAccountId =
				this.cached.get(providerId)?.providerAccountId;
			const sealed = await this.input.issueGrant(
				providerId,
				new ProviderGrantRequest({
					requestId,
					protocolVersion: 1,
					runtimeGeneration: this.input.runtimeGeneration,
					credentialPublicJwk: this.input.credentialPublicJwk,
					reason,
					...(previousProviderAccountId === null ||
					previousProviderAccountId === undefined
						? {}
						: { previousProviderAccountId }),
				}),
			);
			if (
				sealed.providerId !== providerId ||
				sealed.requestId !== requestId ||
				sealed.keyThumbprint !== keyThumbprint
			)
				throw new Error(`${providerId}-auth-update-required`);
			const grant = await openCloudAuthGrant(
				sealed,
				this.input.credentialPrivateKey,
				decodeGrantPlaintext,
			);
			const nowMs = Date.now();
			if (
				grant.zuseAccountId !== this.input.zuseAccountId ||
				grant.workspaceId !== this.input.workspaceId ||
				grant.runtimeGeneration !== this.input.runtimeGeneration ||
				grant.providerId !== providerId ||
				grant.keyThumbprint !== keyThumbprint ||
				grant.authorityIncarnationId !== sealed.authorityIncarnationId ||
				grant.authorityEpoch !== sealed.authorityEpoch ||
				grant.issuedAt > nowMs + 60_000 ||
				grant.expiresAt <= nowMs + MINIMUM_GRANT_LIFETIME_MS
			)
				throw new Error(`${providerId}-auth-update-required`);
			const credential: ProviderCredential = {
				kind: grant.credentialKind,
				secret: grant.secret,
				updatedAt: grant.issuedAt,
			};
			this.cached.set(providerId, {
				credential,
				providerAccountId: grant.providerAccountId,
				issuer: grant.issuer,
				expiresAt: grant.expiresAt,
			});
			this.scheduleProactiveRefresh(providerId, grant.expiresAt);
			const recoveryTimer = this.recoveryTimers.get(providerId);
			if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
			this.recoveryTimers.delete(providerId);
			if (this.recovering.delete(providerId))
				this.input.onRecovered?.(providerId);
			this.input.onStatus?.(providerId, "ready");
			return credential;
		} catch (cause) {
			const reason = reasonOf(cause);
			const status = reason.includes("reconnect-required")
				? "reconnect-required"
				: reason.includes("update-required")
					? "update-required"
					: "reconnecting";
			this.input.onStatus?.(providerId, status);
			if (status !== "update-required") {
				this.recovering.add(providerId);
				this.scheduleRecovery(providerId);
			}
			throw cause;
		}
	}

	private scheduleProactiveRefresh(
		providerId: CloudAuthProvider,
		expiresAt: number,
	): void {
		const existing = this.proactiveTimers.get(providerId);
		if (existing !== undefined) clearTimeout(existing);
		const timer = setTimeout(
			() => void this.resolve(providerId, "proactive").catch(() => undefined),
			Math.max(1_000, expiresAt - Date.now() - PROACTIVE_REFRESH_WINDOW_MS),
		);
		timer.unref();
		this.proactiveTimers.set(providerId, timer);
	}

	private scheduleRecovery(providerId: CloudAuthProvider): void {
		if (this.recoveryTimers.has(providerId)) return;
		const timer = setTimeout(() => {
			this.recoveryTimers.delete(providerId);
			void this.resolve(providerId, "proactive").catch(() => undefined);
		}, 15_000);
		timer.unref();
		this.recoveryTimers.set(providerId, timer);
	}
}
