import { jsonError } from "@/lib/api-error";
import { methodNotAllowed, preflightResponse } from "@/lib/api-method";

// Minimal cloud-waitlist capture: validate the email and forward it, with a
// timestamp, to whatever webhook WAITLIST_WEBHOOK_URL points at (form
// provider, sheet script, internal service). Keeping the sink configurable
// means the site never hard-codes a vendor.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
	const mediaType = request.headers
		.get("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (mediaType !== "application/json") {
		return jsonError(
			415,
			"UNSUPPORTED_MEDIA_TYPE",
			"This endpoint only accepts JSON.",
			"Set Content-Type to application/json and send an object with an email field.",
		);
	}

	let email: unknown;
	try {
		({ email } = await request.json());
	} catch {
		return jsonError(
			400,
			"INVALID_JSON",
			"The request body is not valid JSON.",
			'Send a JSON object such as {"email":"developer@example.com"}.',
		);
	}

	if (
		typeof email !== "string" ||
		!EMAIL_RE.test(email) ||
		email.length > 254
	) {
		return jsonError(
			400,
			"INVALID_EMAIL",
			"The email field must contain a valid email address.",
			"Provide a valid email address no longer than 254 characters.",
		);
	}

	const webhook = process.env.WAITLIST_WEBHOOK_URL;
	if (!webhook) {
		console.error("WAITLIST_WEBHOOK_URL is not configured");
		return jsonError(
			503,
			"SERVICE_UNAVAILABLE",
			"The waitlist is not accepting signups right now.",
			"Try again later or follow the Zuse changelog for availability updates.",
		);
	}

	try {
		const response = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email,
				timestamp: new Date().toISOString(),
				source: "zuse-cloud-waitlist",
			}),
		});
		if (!response.ok) {
			console.error(`Waitlist webhook responded ${response.status}`);
			return jsonError(
				502,
				"UPSTREAM_ERROR",
				"The waitlist service could not save the signup.",
				"Retry the request later. Do not assume the email was registered.",
			);
		}
	} catch (error) {
		console.error("Waitlist webhook request failed", error);
		return jsonError(
			502,
			"UPSTREAM_ERROR",
			"The waitlist service could not save the signup.",
			"Retry the request later. Do not assume the email was registered.",
		);
	}

	return Response.json({ ok: true });
}

const unsupportedMethod = () => methodNotAllowed(["POST"]);

export const GET = unsupportedMethod;
export const PUT = unsupportedMethod;
export const PATCH = unsupportedMethod;
export const DELETE = unsupportedMethod;
export const OPTIONS = () => preflightResponse(["POST"]);
