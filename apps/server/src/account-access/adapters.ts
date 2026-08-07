import type {
	AccountAccessProvider,
	AccountAccessProviderStatus,
	AccountAccessTransferEvent,
	LocalAccountDescriptor,
} from "@zuse/contracts";
import type { Effect, Stream } from "effect";

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
const CLAUDE_SETUP_TOKEN_PATTERN = /\bsk-ant-oat01-[A-Za-z0-9_-]{20,}\b/gu;

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
					: ["anthropic.com", "claude.ai"];
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
	const code = raw.match(DEVICE_CODE_PATTERN)?.[0];
	const url = [...raw.matchAll(URL_PATTERN)]
		.map((match) => match[0])
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
	const parsed = parseDeviceLoginVerification("codex", raw);
	const url = [...raw.matchAll(URL_PATTERN)]
		.map((match) => match[0])
		.map((candidate) => allowedLoginUrl("claude", candidate))
		.find((candidate): candidate is string => candidate !== null);
	return {
		...(url !== undefined ? { url } : {}),
		...(parsed.code !== undefined ? { code: parsed.code } : {}),
	};
};

export const extractClaudeSetupToken = (raw: string): string | null => {
	CLAUDE_SETUP_TOKEN_PATTERN.lastIndex = 0;
	return CLAUDE_SETUP_TOKEN_PATTERN.exec(raw)?.[0] ?? null;
};

export const redactAccountAccessOutput = (raw: string): string => {
	CLAUDE_SETUP_TOKEN_PATTERN.lastIndex = 0;
	return raw.replace(CLAUDE_SETUP_TOKEN_PATTERN, "[credential redacted]");
};
