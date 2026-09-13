// Slack signature verification, thread/file reads, and replies.

const encoder = new TextEncoder();
const SLACK_REQUEST_TIMEOUT_MS = 10_000;
const SLACK_THREAD_MAX_MESSAGES = 500;

import { slackMessageText } from "./automation.ts";

const SLACK_FILE_MAX_BYTES = 20 * 1024 * 1024;

export class SlackRateLimitError extends Error {
	constructor(readonly retryAfterSeconds: number) {
		super("slack_rate_limited");
		this.name = "SlackRateLimitError";
	}
}
export class SlackApiError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(`slack_api_${code}`);
		this.name = "SlackApiError";
	}
	get retryable(): boolean {
		return (
			this.status >= 500 ||
			![
				"invalid_auth",
				"token_revoked",
				"account_inactive",
				"missing_scope",
				"not_in_channel",
				"channel_not_found",
				"thread_not_found",
				"restricted_action",
				"not_allowed_token_type",
			].includes(this.code)
		);
	}
}
const checkRateLimit = (response: Response): void => {
	if (response.status !== 429) return;
	const seconds = Number(response.headers.get("retry-after"));
	throw new SlackRateLimitError(
		Number.isFinite(seconds) && seconds > 0
			? Math.min(86400, Math.ceil(seconds))
			: 60,
	);
};

export interface SlackFile {
	readonly id: string;
	readonly name: string;
	readonly mimetype: string;
	readonly size: number;
	readonly urlPrivateDownload: string;
}

export interface SlackThreadMessage {
	readonly ts: string;
	readonly user?: string;
	readonly text: string;
	readonly files: ReadonlyArray<SlackFile>;
}

export interface SlackFileMetadata {
	readonly id?: string;
	readonly name?: string;
	readonly mimetype?: string;
	readonly size?: number;
	readonly url_private_download?: string;
}

export const parseSlackFiles = (
	files: ReadonlyArray<SlackFileMetadata> | null = [],
): ReadonlyArray<SlackFile> =>
	(files ?? []).flatMap((file): SlackFile[] =>
		file !== null &&
		typeof file === "object" &&
		typeof file.id === "string" &&
		typeof file.name === "string" &&
		typeof file.mimetype === "string" &&
		typeof file.size === "number" &&
		typeof file.url_private_download === "string"
			? [
					{
						id: file.id,
						name: file.name,
						mimetype: file.mimetype,
						size: file.size,
						urlPrivateDownload: file.url_private_download,
					},
				]
			: [],
	);

const slackClientMessageId = async (
	idempotencyKey: string,
): Promise<string> => {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(idempotencyKey)),
	);
	// Derive a stable UUID from the durable source event so retries use the
	// exact same Slack duplicate-suppression identifier.
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes.slice(0, 16)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const hmacSha256Hex = async (
	secret: string,
	message: string,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(message),
	);
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

const timingSafeEqual = (left: string, right: string): boolean => {
	if (left.length !== right.length) return false;
	let mismatch = 0;
	for (let index = 0; index < left.length; index++)
		mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return mismatch === 0;
};

/**
 * Verify Slack's `v0` request signature over the raw body. Returns false for
 * requests older than five minutes (replay window).
 */
export const verifySlackSignature = async (input: {
	readonly signingSecret: string;
	readonly timestampHeader: string | null;
	readonly signatureHeader: string | null;
	readonly rawBody: string;
}): Promise<boolean> => {
	if (input.timestampHeader === null || input.signatureHeader === null)
		return false;
	const timestamp = Number(input.timestampHeader);
	if (!Number.isFinite(timestamp)) return false;
	if (Math.abs(Date.now() / 1_000 - timestamp) > 300) return false;
	const expected = `v0=${await hmacSha256Hex(
		input.signingSecret,
		`v0:${input.timestampHeader}:${input.rawBody}`,
	)}`;
	return timingSafeEqual(expected, input.signatureHeader);
};

/**
 * Verify a Zuse webhook delivery (`zuse-signature: t=<unixSeconds>,v1=<hex>`
 * over `<t>.<rawBody>` with the endpoint's `whsec_…` secret, 5-minute window).
 */
export const verifyZuseSignature = async (input: {
	readonly secret: string;
	readonly signatureHeader: string | null;
	readonly rawBody: string;
}): Promise<boolean> => {
	const match = /^t=(\d+),v1=([0-9a-f]+)$/u.exec(input.signatureHeader ?? "");
	if (match === null) return false;
	const [, timestamp, signature] = match;
	if (timestamp === undefined || signature === undefined) return false;
	if (Math.abs(Date.now() / 1_000 - Number(timestamp)) > 300) return false;
	const expected = await hmacSha256Hex(
		input.secret,
		`${timestamp}.${input.rawBody}`,
	);
	return timingSafeEqual(expected, signature);
};

export const slackApi = async (
	botToken: string,
	method: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${botToken}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
	});
	checkRateLimit(response);
	let payload: Record<string, unknown>;
	try {
		payload = (await response.json()) as Record<string, unknown>;
	} catch {
		throw new Error(`slack_api_invalid_response:${response.status}`);
	}
	if (!response.ok || payload.ok !== true)
		throw new SlackApiError(
			String(payload.error ?? response.status),
			response.status,
		);
	return payload;
};

export const postSlackMessage = async (input: {
	readonly botToken: string;
	readonly channel: string;
	readonly text: string;
	readonly threadTs?: string;
	readonly idempotencyKey?: string;
	readonly blocks?: readonly unknown[];
}): Promise<{ readonly ts: string }> => {
	const payload = await slackApi(input.botToken, "chat.postMessage", {
		channel: input.channel,
		...(input.blocks ? { blocks: input.blocks } : {}),
		text: input.text.slice(0, 39000),
		unfurl_links: false,
		unfurl_media: false,
		...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
		...(input.idempotencyKey === undefined
			? {}
			: { client_msg_id: await slackClientMessageId(input.idempotencyKey) }),
	});
	if (typeof payload.ts !== "string" || !payload.ts)
		throw new Error("slack_api_missing_message_ts");
	return { ts: payload.ts };
};
const slackFileUrl = (value: string): URL => {
	const url = new URL(value);
	const allowed =
		url.protocol === "https:" &&
		(url.hostname === "files.slack.com" ||
			url.hostname.endsWith(".slack.com") ||
			url.hostname.endsWith(".slack-edge.com") ||
			url.hostname.endsWith(".slack-files.com"));
	if (!allowed) throw new Error("slack_file_url_invalid");
	return url;
};

export const downloadSlackFile = async (input: {
	readonly botToken: string;
	readonly file: SlackFile;
}): Promise<Uint8Array> => {
	if (
		!Number.isSafeInteger(input.file.size) ||
		input.file.size <= 0 ||
		input.file.size > SLACK_FILE_MAX_BYTES
	)
		throw new Error("slack_file_size_invalid");
	const response = await fetch(slackFileUrl(input.file.urlPrivateDownload), {
		headers: { authorization: `Bearer ${input.botToken}` },
		redirect: "error",
		signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`slack_file_download_${response.status}`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("slack_file_empty");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > SLACK_FILE_MAX_BYTES) {
				await reader.cancel();
				throw new Error("slack_file_size_invalid");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (bytes.byteLength === 0 || bytes.byteLength > SLACK_FILE_MAX_BYTES)
		throw new Error("slack_file_size_invalid");
	return bytes;
};

export const readSlackThread = async (input: {
	/** Use a token authorized to read this conversation; DMs use the bot token. */
	readonly token: string;
	readonly channel: string;
	readonly threadTs: string;
	readonly latestTs?: string;
	readonly checkpoint?: {
		load(): Promise<string | null>;
		save(value: string): Promise<void>;
	};
}): Promise<ReadonlyArray<SlackThreadMessage>> => {
	const cached = await input.checkpoint?.load();
	const progress: {
		messages: SlackThreadMessage[];
		cursor?: string;
		seen: string[];
		done?: boolean;
	} = cached ? JSON.parse(cached) : { messages: [], seen: [] };
	const messages = progress.messages;
	if (progress.done) return messages;
	let cursor = progress.cursor;
	const seenCursors = new Set(progress.seen);
	do {
		const url = new URL("https://slack.com/api/conversations.replies");
		url.searchParams.set("channel", input.channel);
		url.searchParams.set("ts", input.threadTs);
		url.searchParams.set("limit", "15");
		if (input.latestTs) {
			url.searchParams.set("latest", input.latestTs);
			url.searchParams.set("inclusive", "true");
		}
		if (cursor !== undefined) url.searchParams.set("cursor", cursor);
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${input.token}` },
			signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
		});
		checkRateLimit(response);
		const body = (await response.json()) as {
			readonly ok?: boolean;
			readonly error?: string;
			readonly messages?: ReadonlyArray<{
				readonly ts?: string;
				readonly user?: string;
				readonly text?: string;
				readonly blocks?: unknown;
				readonly attachments?: unknown;
				readonly files?: ReadonlyArray<SlackFileMetadata>;
			}>;
			readonly response_metadata?: { readonly next_cursor?: string };
		};
		if (!response.ok || body.ok !== true)
			throw new SlackApiError(
				String(body.error ?? (response.ok ? "rejected" : response.status)),
				response.status,
			);
		for (const message of body.messages ?? []) {
			if (typeof message.ts !== "string") continue;
			messages.push({
				ts: message.ts,
				...(message.user === undefined ? {} : { user: message.user }),
				text: slackMessageText(message),
				files: parseSlackFiles(message.files),
			});
			if (messages.length > SLACK_THREAD_MAX_MESSAGES)
				messages.splice(0, messages.length - SLACK_THREAD_MAX_MESSAGES);
		}
		const next = body.response_metadata?.next_cursor?.trim();
		cursor = next === undefined || next.length === 0 ? undefined : next;
		if (cursor !== undefined) {
			if (seenCursors.has(cursor) || seenCursors.size >= 50)
				throw new Error("slack_thread_pagination_limit");
			seenCursors.add(cursor);
		}
		// Bound durable context as well as attachment buffering. Retain newest data.
		let textBudget = 60_000;
		let fileBudget = 8;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (!message) continue;
			const text = textBudget > 0 ? message.text.slice(-textBudget) : "";
			const files = fileBudget > 0 ? message.files.slice(-fileBudget) : [];
			textBudget -= text.length;
			fileBudget -= files.length;
			messages[index] = { ...message, text, files };
		}
		await input.checkpoint?.save(
			JSON.stringify({
				messages,
				cursor,
				seen: [...seenCursors],
				done: cursor === undefined,
			}),
		);
	} while (cursor !== undefined);
	return messages;
};
