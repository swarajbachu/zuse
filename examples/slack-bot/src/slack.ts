// Minimal Slack helpers: request-signature verification and the one Web API
// call this bot needs. No SDK — everything is fetch + WebCrypto so the example
// runs on any Workers-compatible runtime.

const encoder = new TextEncoder();
const SLACK_REQUEST_TIMEOUT_MS = 10_000;
const SLACK_THREAD_MAX_MESSAGES = 500;
const SLACK_FILE_MAX_BYTES = 20 * 1024 * 1024;

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

export const postSlackMessage = async (input: {
	readonly botToken: string;
	readonly channel: string;
	readonly text: string;
	readonly threadTs?: string;
	readonly idempotencyKey?: string;
}): Promise<{ readonly ts: string }> => {
	const response = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			authorization: `Bearer ${input.botToken}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({
			channel: input.channel,
			text: input.text,
			...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
			...(input.idempotencyKey === undefined
				? {}
				: {
						client_msg_id: await slackClientMessageId(input.idempotencyKey),
					}),
		}),
		signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
	});
	const rawBody = await response.text();
	let payload: {
		readonly ok?: boolean;
		readonly ts?: string;
		readonly error?: string;
	};
	try {
		payload = JSON.parse(rawBody) as typeof payload;
	} catch {
		throw new Error(`slack_api_invalid_response:${response.status}`);
	}
	if (!response.ok || payload.ok !== true) {
		throw new Error(
			`slack_api_${payload.error ?? (response.ok ? "rejected" : response.status)}`,
		);
	}
	if (typeof payload.ts !== "string" || payload.ts.length === 0)
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
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0 || bytes.byteLength > SLACK_FILE_MAX_BYTES)
		throw new Error("slack_file_size_invalid");
	return bytes;
};

export const readSlackThread = async (input: {
	/** User token for channel threads; Slack permits bot tokens for DMs only. */
	readonly token: string;
	readonly channel: string;
	readonly threadTs: string;
}): Promise<ReadonlyArray<SlackThreadMessage>> => {
	const messages: SlackThreadMessage[] = [];
	let cursor: string | undefined;
	do {
		const url = new URL("https://slack.com/api/conversations.replies");
		url.searchParams.set("channel", input.channel);
		url.searchParams.set("ts", input.threadTs);
		url.searchParams.set("limit", "100");
		if (cursor !== undefined) url.searchParams.set("cursor", cursor);
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${input.token}` },
			signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
		});
		const body = (await response.json()) as {
			readonly ok?: boolean;
			readonly error?: string;
			readonly messages?: ReadonlyArray<{
				readonly ts?: string;
				readonly user?: string;
				readonly text?: string;
				readonly files?: ReadonlyArray<{
					readonly id?: string;
					readonly name?: string;
					readonly mimetype?: string;
					readonly size?: number;
					readonly url_private_download?: string;
				}>;
			}>;
			readonly response_metadata?: { readonly next_cursor?: string };
		};
		if (!response.ok || body.ok !== true)
			throw new Error(
				`slack_api_${body.error ?? (response.ok ? "rejected" : response.status)}`,
			);
		for (const message of body.messages ?? []) {
			if (typeof message.ts !== "string") continue;
			const files = (message.files ?? []).flatMap((file): SlackFile[] =>
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
			messages.push({
				ts: message.ts,
				...(message.user === undefined ? {} : { user: message.user }),
				text: message.text ?? "",
				files,
			});
			if (messages.length > SLACK_THREAD_MAX_MESSAGES)
				messages.splice(0, messages.length - SLACK_THREAD_MAX_MESSAGES);
		}
		const next = body.response_metadata?.next_cursor?.trim();
		cursor = next === undefined || next.length === 0 ? undefined : next;
	} while (cursor !== undefined);
	return messages;
};
