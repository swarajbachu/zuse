// Minimal Slack helpers: request-signature verification and the one Web API
// call this bot needs. No SDK — everything is fetch + WebCrypto so the example
// runs on any Workers-compatible runtime.

const encoder = new TextEncoder();

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
}): Promise<{ readonly ts: string | null }> => {
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
		}),
	});
	const payload = (await response.json().catch(() => ({}))) as {
		readonly ok?: boolean;
		readonly ts?: string;
	};
	return {
		ts: payload.ok === true && payload.ts !== undefined ? payload.ts : null,
	};
};
