import type {
	AccountAccessProvider,
	AccountAccessProviderStatus,
	AccountAccessTransferEvent,
	LocalAccountDescriptor,
} from "@zuse/contracts";
import type { Effect, Stream } from "effect";
import stripAnsi from "strip-ansi";

import type { AccountAccessServiceError } from "./errors.ts";

export interface LocalAccountSource {
	readonly providerId: AccountAccessProvider;
	readonly detect: () => Effect.Effect<
		LocalAccountDescriptor,
		AccountAccessServiceError
	>;
}

export interface CloudAccountAccessAdapter {
	readonly providerId: AccountAccessProvider;
	readonly status: () => Effect.Effect<
		AccountAccessProviderStatus,
		AccountAccessServiceError
	>;
	readonly startLogin?: () => Stream.Stream<
		AccountAccessTransferEvent,
		AccountAccessServiceError
	>;
	readonly disconnect: () => Effect.Effect<
		AccountAccessProviderStatus,
		AccountAccessServiceError
	>;
}

type DeviceLoginProvider = "github" | "codex";

const LOGIN_COMMANDS: Record<
	DeviceLoginProvider,
	{
		readonly command: string;
		readonly args: ReadonlyArray<string>;
		readonly environment?: Readonly<Record<string, string>>;
	}
> = {
	github: {
		command: "gh",
		environment: { GH_PROMPT_DISABLED: "1" },
		args: [
			"auth",
			"login",
			"--hostname",
			"github.com",
			"--git-protocol",
			"https",
			"--web",
		],
	},
	codex: {
		command: "codex",
		args: ["login", "--device-auth"],
	},
};

export const getAccountAccessLoginCommand = (
	providerId: DeviceLoginProvider,
): {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly environment?: Readonly<Record<string, string>>;
} => LOGIN_COMMANDS[providerId];

const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/u;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/giu;
const CLAUDE_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const CLAUDE_SETUP_TOKEN_MINIMUM_SECRET_LENGTH = 20;
const CLAUDE_SETUP_TOKEN_CHARACTER = /^[A-Za-z0-9_-]$/u;
const CLAUDE_SETUP_TOKEN_FOLLOWING_COPY = "Store this token securely";
const ESCAPE_CHARACTER = String.fromCharCode(27);

interface ClaudeSetupTokenMatch {
	readonly token: string;
	readonly start: number;
	readonly end: number;
}

const ansiSequenceAt = (raw: string, cursor: number): string | null => {
	if (raw[cursor] !== ESCAPE_CHARACTER) return null;
	const match = /^\[[0-?]*[ -/]*[@-~]/u.exec(raw.slice(cursor + 1));
	return match === null ? null : `${ESCAPE_CHARACTER}${match[0]}`;
};

/**
 * Claude renders setup tokens through Ink, so a token may contain terminal
 * line wraps and SGR sequences in the PTY stream. A match is complete only
 * once the color reset or Claude's following safety copy arrives. Treating a
 * chunk boundary as the end would seal a truncated credential.
 */
const findClaudeSetupToken = (
	raw: string,
	fromIndex = 0,
): ClaudeSetupTokenMatch | null => {
	let start = raw.indexOf(CLAUDE_SETUP_TOKEN_PREFIX, fromIndex);
	while (start >= 0) {
		let cursor = start + CLAUDE_SETUP_TOKEN_PREFIX.length;
		let secret = "";
		while (cursor < raw.length) {
			const character = raw[cursor];
			if (
				character !== undefined &&
				CLAUDE_SETUP_TOKEN_CHARACTER.test(character)
			) {
				secret += character;
				cursor += 1;
				continue;
			}
			if (character === "\r" || character === "\n") {
				const lineEnd = cursor;
				while (raw[cursor] === "\r" || raw[cursor] === "\n") cursor += 1;
				if (raw.startsWith(CLAUDE_SETUP_TOKEN_FOLLOWING_COPY, cursor)) {
					return secret.length >= CLAUDE_SETUP_TOKEN_MINIMUM_SECRET_LENGTH
						? {
								token: `${CLAUDE_SETUP_TOKEN_PREFIX}${secret}`,
								start,
								end: lineEnd,
							}
						: null;
				}
				continue;
			}
			if (character === ESCAPE_CHARACTER) {
				const sequence = ansiSequenceAt(raw, cursor);
				if (sequence === null) break;
				if (
					sequence.endsWith("m") &&
					/(?:^|;)(?:0|39)(?:;|m)/u.test(sequence.slice(2))
				) {
					return secret.length >= CLAUDE_SETUP_TOKEN_MINIMUM_SECRET_LENGTH
						? {
								token: `${CLAUDE_SETUP_TOKEN_PREFIX}${secret}`,
								start,
								end: cursor,
							}
						: null;
				}
				cursor += sequence.length;
				continue;
			}
			break;
		}
		start = raw.indexOf(CLAUDE_SETUP_TOKEN_PREFIX, start + 1);
	}
	return null;
};

const oscLoginUrls = (raw: string): ReadonlyArray<string> => {
	const escapeCharacter = String.fromCharCode(27);
	const bell = String.fromCharCode(7);
	const prefix = `${escapeCharacter}]8;`;
	const results: string[] = [];
	let cursor = 0;
	while (cursor < raw.length) {
		const start = raw.indexOf(prefix, cursor);
		if (start < 0) break;
		const urlStart = raw.indexOf(";", start + prefix.length);
		if (urlStart < 0) break;
		const bellEnd = raw.indexOf(bell, urlStart + 1);
		const escapeEnd = raw.indexOf(`${escapeCharacter}\\`, urlStart + 1);
		const ends = [bellEnd, escapeEnd].filter((value) => value >= 0);
		if (ends.length === 0) break;
		const end = Math.min(...ends);
		const candidate = raw.slice(urlStart + 1, end);
		if (candidate.startsWith("https://")) results.push(candidate);
		cursor = end + 1;
	}
	return results;
};

const loginUrlCandidates = (raw: string): ReadonlyArray<string> => {
	const visible = stripAnsi(raw);
	return [
		...oscLoginUrls(raw),
		...[...visible.matchAll(URL_PATTERN)].map((match) => match[0]),
	].filter((candidate): candidate is string => candidate !== undefined);
};

const allowedLoginUrl = (
	providerId: DeviceLoginProvider | "claude",
	candidate: string,
): string | null => {
	try {
		const url = new URL(candidate.replace(/[),.;\]}]+$/u, ""));
		if (url.protocol !== "https:" || url.username || url.password) return null;
		const allowedDomains =
			providerId === "github"
				? ["github.com"]
				: providerId === "codex"
					? ["openai.com", "chatgpt.com"]
					: ["anthropic.com", "claude.ai", "claude.com"];
		return allowedDomains.some(
			(domain) =>
				url.hostname === domain || url.hostname.endsWith(`.${domain}`),
		)
			? url.toString()
			: null;
	} catch {
		return null;
	}
};

export const parseDeviceLoginVerification = (
	providerId: DeviceLoginProvider,
	raw: string,
): { readonly url?: string; readonly code?: string } => {
	const safe = stripAnsi(raw);
	const code = safe.match(DEVICE_CODE_PATTERN)?.[0];
	const url = loginUrlCandidates(raw)
		.map((candidate) => allowedLoginUrl(providerId, candidate))
		.find((candidate): candidate is string => candidate !== null);
	return {
		...(url !== undefined ? { url } : {}),
		...(code !== undefined ? { code } : {}),
	};
};

export const parseClaudeSetupVerification = (
	raw: string,
): { readonly url?: string; readonly code?: string } => {
	const safe = stripAnsi(raw);
	const parsed = parseDeviceLoginVerification("codex", safe);
	const url = loginUrlCandidates(raw)
		.map((candidate) => allowedLoginUrl("claude", candidate))
		.find((candidate): candidate is string => candidate !== null);
	return {
		...(url !== undefined ? { url } : {}),
		...(parsed.code !== undefined ? { code: parsed.code } : {}),
	};
};

export const extractClaudeSetupToken = (raw: string): string | null => {
	return findClaudeSetupToken(raw)?.token ?? null;
};

export const parseClaudeSetupFailure = (
	raw: string,
): "invalid-code" | "exchange-failed" | "policy-blocked" | null => {
	const safe = stripAnsi(raw);
	if (/Invalid code/iu.test(safe)) return "invalid-code";
	if (
		/Token exchange failed|Failed to exchange authorization code/iu.test(safe)
	) {
		return "exchange-failed";
	}
	if (/policy does not permit/iu.test(safe)) return "policy-blocked";
	return null;
};

export const redactAccountAccessOutput = (raw: string): string => {
	let result = raw;
	let cursor = 0;
	while (true) {
		const start = result.indexOf(CLAUDE_SETUP_TOKEN_PREFIX, cursor);
		if (start < 0) return result;
		const complete = findClaudeSetupToken(result, start);
		if (complete?.start === start) {
			result = `${result.slice(0, start)}[credential redacted]${result.slice(complete.end)}`;
			cursor = start + "[credential redacted]".length;
			continue;
		}
		// Even an incomplete PTY chunk is secret-bearing. Redact the partial
		// suffix rather than allowing it into diagnostics while awaiting more data.
		let end = start + CLAUDE_SETUP_TOKEN_PREFIX.length;
		while (end < result.length) {
			const character = result[end];
			if (
				character === undefined ||
				(!CLAUDE_SETUP_TOKEN_CHARACTER.test(character) &&
					character !== "\r" &&
					character !== "\n")
			) {
				break;
			}
			end += 1;
		}
		result = `${result.slice(0, start)}[credential redacted]${result.slice(end)}`;
		cursor = start + "[credential redacted]".length;
	}
};
