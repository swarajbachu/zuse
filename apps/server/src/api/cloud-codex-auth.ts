import type {
	CodexChatgptAuthTokens,
	CodexExternalAuthProvider,
} from "@zuse/agents/drivers/codex-app-server-client";
import {
	type CodexGrantRefreshReason,
	CodexGrantRequest,
	type SealedCodexGrant,
} from "@zuse/contracts";
import { type CryptoKey, calculateJwkThumbprint, type JWK } from "jose";
import { openCloudAuthGrant } from "./cloud-grant-crypto.ts";

const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const MINIMUM_GRANT_LIFETIME_MS = 60 * 1_000;

export type CloudCodexAuthStatus =
	| "initializing"
	| "ready"
	| "codex-auth-reconnecting"
	| "codex-auth-reconnect-required"
	| "codex-auth-update-required";

interface CodexGrantPlaintext {
	readonly zuseAccountId: string;
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly keyThumbprint: string;
	readonly authorityIncarnationId: string;
	readonly authorityEpoch: number;
	readonly chatgptAccountId: string;
	readonly chatgptPlanType: string | null;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly accessToken: string;
}

export interface CloudCodexAuthInput {
	readonly zuseAccountId: string;
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly credentialPublicJwk: string;
	readonly credentialPrivateKey: CryptoKey;
	readonly issueGrant: (
		request: CodexGrantRequest,
	) => Promise<SealedCodexGrant>;
	readonly onStatus?: (status: CloudCodexAuthStatus) => void;
	readonly onConsumersRecovered?: (consumerIds: ReadonlyArray<string>) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const failureReason = (cause: unknown): string => {
	if (isRecord(cause) && typeof cause.reason === "string") return cause.reason;
	return cause instanceof Error ? cause.message : "";
};

const decodeGrantPlaintext = (value: unknown): CodexGrantPlaintext => {
	if (!isRecord(value)) throw new Error("codex-auth-update-required");
	for (const field of [
		"zuseAccountId",
		"workspaceId",
		"keyThumbprint",
		"authorityIncarnationId",
		"chatgptAccountId",
		"accessToken",
	] as const)
		if (typeof value[field] !== "string" || value[field].length === 0)
			throw new Error("codex-auth-update-required");
	for (const field of [
		"runtimeGeneration",
		"authorityEpoch",
		"issuedAt",
		"expiresAt",
	] as const)
		if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]))
			throw new Error("codex-auth-update-required");
	if (
		value.chatgptPlanType !== null &&
		typeof value.chatgptPlanType !== "string"
	)
		throw new Error("codex-auth-update-required");
	return value as unknown as CodexGrantPlaintext;
};

/**
 * Workspace-scoped, memory-only Codex access-token cache. Refreshes are
 * single-flight and every grant is generation/key/account fenced.
 */
export class CloudCodexAuth implements CodexExternalAuthProvider {
	private cached: CodexChatgptAuthTokens | null = null;
	private inFlight: Promise<CodexChatgptAuthTokens> | null = null;
	private proactiveTimer: NodeJS.Timeout | null = null;
	private recoveryTimer: NodeJS.Timeout | null = null;
	private readonly blockedConsumers = new Set<string>();
	private recoveryPending = false;
	private readonly keyThumbprint: Promise<string>;

	constructor(private readonly input: CloudCodexAuthInput) {
		this.keyThumbprint = calculateJwkThumbprint(
			JSON.parse(input.credentialPublicJwk) as JWK,
		);
	}

	readonly getTokens = (request: {
		readonly reason: CodexGrantRefreshReason;
		readonly previousChatgptAccountId?: string;
	}): Promise<CodexChatgptAuthTokens> => {
		const nowMs = Date.now();
		if (
			request.reason !== "unauthorized" &&
			this.cached !== null &&
			this.cached.expiresAt > nowMs + PROACTIVE_REFRESH_WINDOW_MS
		)
			return Promise.resolve(this.cached);
		if (this.inFlight !== null) return this.inFlight;
		this.input.onStatus?.("codex-auth-reconnecting");
		this.inFlight = this.refresh(request).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	};

	async initialize(): Promise<void> {
		await this.getTokens({ reason: "initial" });
	}

	close(): void {
		if (this.proactiveTimer !== null) clearTimeout(this.proactiveTimer);
		if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
		this.proactiveTimer = null;
		this.recoveryTimer = null;
		this.cached = null;
		this.blockedConsumers.clear();
		this.recoveryPending = false;
	}

	readonly onDeliveryFailure = (input: {
		readonly consumerId?: string;
		readonly reason: string;
	}): void => {
		if (input.consumerId !== undefined)
			this.blockedConsumers.add(input.consumerId);
		this.recoveryPending = true;
		this.input.onStatus?.(
			input.reason.includes("reconnect-required")
				? "codex-auth-reconnect-required"
				: "codex-auth-reconnecting",
		);
		this.scheduleRecoveryRetry();
	};

	private async refresh(request: {
		readonly reason: CodexGrantRefreshReason;
		readonly previousChatgptAccountId?: string;
	}): Promise<CodexChatgptAuthTokens> {
		try {
			const keyThumbprint = await this.keyThumbprint;
			const requestId = crypto.randomUUID();
			const sealed = await this.input.issueGrant(
				new CodexGrantRequest({
					requestId,
					protocolVersion: 1,
					runtimeGeneration: this.input.runtimeGeneration,
					credentialPublicJwk: this.input.credentialPublicJwk,
					reason: request.reason,
					...(request.previousChatgptAccountId === undefined
						? {}
						: {
								previousChatgptAccountId: request.previousChatgptAccountId,
							}),
				}),
			);
			if (
				sealed.requestId !== requestId ||
				sealed.keyThumbprint !== keyThumbprint
			)
				throw new Error("codex-auth-update-required");
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
				grant.keyThumbprint !== keyThumbprint ||
				grant.authorityIncarnationId !== sealed.authorityIncarnationId ||
				grant.authorityEpoch !== sealed.authorityEpoch ||
				grant.issuedAt > nowMs + 60_000 ||
				grant.expiresAt <= nowMs + MINIMUM_GRANT_LIFETIME_MS
			)
				throw new Error("codex-auth-update-required");
			if (
				request.previousChatgptAccountId !== undefined &&
				request.previousChatgptAccountId !== grant.chatgptAccountId
			)
				throw new Error("codex-auth-reconnect-required");
			const tokens: CodexChatgptAuthTokens = {
				accessToken: grant.accessToken,
				chatgptAccountId: grant.chatgptAccountId,
				chatgptPlanType: grant.chatgptPlanType,
				expiresAt: grant.expiresAt,
			};
			this.cached = tokens;
			this.scheduleProactiveRefresh(tokens.expiresAt);
			if (this.recoveryTimer !== null) {
				clearTimeout(this.recoveryTimer);
				this.recoveryTimer = null;
			}
			if (this.recoveryPending) {
				const consumers = [...this.blockedConsumers];
				this.blockedConsumers.clear();
				this.recoveryPending = false;
				this.input.onConsumersRecovered?.(consumers);
			}
			this.input.onStatus?.("ready");
			return tokens;
		} catch (cause) {
			const reason = failureReason(cause);
			const status = reason.includes("reconnect-required")
				? "codex-auth-reconnect-required"
				: reason.includes("update-required")
					? "codex-auth-update-required"
					: "codex-auth-reconnecting";
			this.input.onStatus?.(status);
			if (status !== "codex-auth-update-required") {
				this.recoveryPending = true;
				this.scheduleRecoveryRetry();
			}
			throw cause;
		}
	}

	private scheduleProactiveRefresh(expiresAt: number): void {
		if (this.proactiveTimer !== null) clearTimeout(this.proactiveTimer);
		const delay = Math.max(
			1_000,
			expiresAt - Date.now() - PROACTIVE_REFRESH_WINDOW_MS,
		);
		this.proactiveTimer = setTimeout(() => {
			void this.getTokens({ reason: "proactive" }).catch(() => undefined);
		}, delay);
		this.proactiveTimer.unref();
	}

	private scheduleRecoveryRetry(): void {
		if (this.recoveryTimer !== null) return;
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = null;
			void this.getTokens({ reason: "proactive" }).catch(() => undefined);
		}, 15_000);
		this.recoveryTimer.unref();
	}
}
