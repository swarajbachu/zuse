import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Account } from "@zuse/agents/codex-generated/v2/Account";
import type { GetAccountResponse } from "@zuse/agents/codex-generated/v2/GetAccountResponse";
import {
	CodexAppServerClient,
	getDefaultCodexExternalAuthTokens,
} from "@zuse/agents/drivers/codex-app-server-client";
import { defaultProviderAccountHome } from "@zuse/agents/drivers/provider-account-env";
import {
	MemoizeRpcs,
	VoiceFallbackTicketError,
	VoiceUnavailableError,
	VoiceValidationError,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	MAX_VOICE_BYTES,
	MAX_VOICE_DURATION_MS,
	voiceValidationReason,
} from "./policy.ts";
import {
	uploadVoiceRecording,
	VOICE_TRANSCRIPTION_ENDPOINT,
} from "./upload.ts";

const TICKET_LIFETIME_MS = 30_000;
const tickets = new Map<string, { expiresAt: number }>();

type AccountAuth = {
	readonly token: string;
	readonly accountId: string | null;
};

const codexHome = (): string => defaultProviderAccountHome("codex");

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;

const firstString = (
	record: Record<string, unknown> | null,
	keys: readonly string[],
): string | null => {
	if (record === null) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
};

const readAccountAuth = async (): Promise<AccountAuth> => {
	const parsed = JSON.parse(
		await readFile(join(codexHome(), "auth.json"), "utf8"),
	) as unknown;
	const root = asRecord(parsed);
	const tokens = asRecord(root?.tokens);
	const token =
		firstString(tokens, ["access_token", "accessToken"]) ??
		firstString(root, ["access_token", "accessToken"]);
	if (token === null) throw new Error("compatible account token unavailable");
	return {
		token,
		accountId:
			firstString(tokens, ["account_id", "accountId", "chatgpt_account_id"]) ??
			firstString(root, ["account_id", "accountId", "chatgpt_account_id"]),
	};
};

const refreshCompatibleAccount = async (): Promise<AccountAuth> => {
	const external = await getDefaultCodexExternalAuthTokens("proactive");
	if (external !== null) {
		return {
			token: external.accessToken,
			accountId: external.chatgptAccountId,
		};
	}
	let client: CodexAppServerClient | null = null;
	try {
		client = await CodexAppServerClient.start({
			codexPath: "codex",
			startupTimeoutMs: 5_000,
			onNotification: () => {},
			onServerRequest: (_request, respond) => respond(null),
		});
		const response = await client.request<GetAccountResponse>("account/read", {
			refreshToken: true,
		});
		const account: Account | null = response.account;
		if (account?.type !== "chatgpt")
			throw new Error("a compatible signed-in account is required");
		return await readAccountAuth();
	} finally {
		client?.close();
	}
};

/** Access tokens outlive this by far; reuse avoids an agent launch per phrase. */
const ACCOUNT_REUSE_MS = 5 * 60_000;
let cachedAccount: {
	readonly auth: Promise<AccountAuth>;
	readonly expiresAt: number;
} | null = null;

/**
 * Dictation transcribes phrase by phrase, so every request needs the account.
 * Concurrent callers share one refresh; a rejected token forces a fresh one.
 */
const compatibleAccount = (fresh = false): Promise<AccountAuth> => {
	const now = Date.now();
	if (!fresh && cachedAccount !== null && cachedAccount.expiresAt > now)
		return cachedAccount.auth;
	const entry = {
		auth: refreshCompatibleAccount(),
		expiresAt: now + ACCOUNT_REUSE_MS,
	};
	cachedAccount = entry;
	entry.auth.catch(() => {
		if (cachedAccount === entry) cachedAccount = null;
	});
	return entry.auth;
};

const validateRecording = (
	bytes: Uint8Array,
	mimeType: string,
	durationMs: number,
): VoiceValidationError | null => {
	const reason = voiceValidationReason(bytes, mimeType, durationMs);
	return reason === null ? null : new VoiceValidationError({ reason });
};

const Capabilities = MemoizeRpcs.toLayerHandler("voice.capabilities", () =>
	Effect.promise(async () => {
		try {
			await compatibleAccount();
			return {
				available: true,
				accountKind: "chatgpt" as const,
				maxDurationSeconds: MAX_VOICE_DURATION_MS / 1_000,
				maxBytes: MAX_VOICE_BYTES,
			};
		} catch {
			return {
				available: false,
				accountKind: null,
				maxDurationSeconds: MAX_VOICE_DURATION_MS / 1_000,
				maxBytes: MAX_VOICE_BYTES,
			};
		}
	}),
);

const Prewarm = MemoizeRpcs.toLayerHandler("voice.prewarm", () =>
	Effect.tryPromise({
		try: async () => {
			await compatibleAccount();
			return { ready: true };
		},
		catch: () =>
			new VoiceUnavailableError({
				reason: "A compatible signed-in account is unavailable.",
			}),
	}),
);

const Transcribe = MemoizeRpcs.toLayerHandler(
	"voice.transcribe",
	({ bytes, mimeType, durationMs }) =>
		Effect.gen(function* () {
			const validation = validateRecording(bytes, mimeType, durationMs);
			if (validation !== null) return yield* validation;
			const upload = (fresh: boolean) =>
				Effect.gen(function* () {
					const auth = yield* Effect.tryPromise({
						try: () => compatibleAccount(fresh),
						catch: () =>
							new VoiceUnavailableError({
								reason: "A compatible signed-in account is unavailable.",
							}),
					});
					return yield* Effect.tryPromise({
						try: () =>
							uploadVoiceRecording({ ...auth, bytes, mimeType, fetch }),
						catch: () =>
							new VoiceUnavailableError({
								reason: "Transcription could not be completed.",
							}),
					});
				});
			let result = yield* upload(false);
			// A reused token may have been revoked since it was cached.
			if (
				result._tag === "fallback" &&
				result.reason === "authentication-rejected"
			)
				result = yield* upload(true);
			if (result._tag === "transcribed") return result;
			const now = Date.now();
			for (const [id, pending] of tickets) {
				if (pending.expiresAt < now) tickets.delete(id);
			}
			const ticket = crypto.randomUUID();
			tickets.set(ticket, { expiresAt: now + TICKET_LIFETIME_MS });
			return {
				_tag: "phoneFallbackRequired" as const,
				reason: result.reason,
				ticket,
			};
		}),
);

const ResolveAuth = MemoizeRpcs.toLayerHandler(
	"voice.resolveAuth",
	({ ticket }) =>
		Effect.gen(function* () {
			const pending = tickets.get(ticket);
			tickets.delete(ticket);
			if (pending === undefined || pending.expiresAt < Date.now()) {
				return yield* new VoiceFallbackTicketError({
					reason: "Fallback authorization expired or was already used.",
				});
			}
			const auth = yield* Effect.tryPromise({
				try: () => compatibleAccount(),
				catch: () =>
					new VoiceUnavailableError({
						reason: "A compatible signed-in account is unavailable.",
					}),
			});
			return {
				token: auth.token,
				accountId: auth.accountId,
				endpoint: VOICE_TRANSCRIPTION_ENDPOINT,
			};
		}),
);

export const VoiceHandlersLayer = Layer.mergeAll(
	Capabilities,
	Prewarm,
	Transcribe,
	ResolveAuth,
);
