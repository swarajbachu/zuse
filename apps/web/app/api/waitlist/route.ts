import { NextResponse } from "next/server";

// Minimal cloud-waitlist capture: validate the email and forward it, with a
// timestamp, to whatever webhook WAITLIST_WEBHOOK_URL points at (form
// provider, sheet script, internal service). Keeping the sink configurable
// means the site never hard-codes a vendor.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
	let email: unknown;
	try {
		({ email } = await request.json());
	} catch {
		return NextResponse.json({ error: "Invalid request." }, { status: 400 });
	}

	if (
		typeof email !== "string" ||
		!EMAIL_RE.test(email) ||
		email.length > 254
	) {
		return NextResponse.json(
			{ error: "Enter a valid email address." },
			{ status: 400 },
		);
	}

	const webhook = process.env.WAITLIST_WEBHOOK_URL;
	if (!webhook) {
		console.error("WAITLIST_WEBHOOK_URL is not configured");
		return NextResponse.json(
			{ error: "The waitlist is not accepting signups right now." },
			{ status: 503 },
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
			return NextResponse.json(
				{ error: "Could not save your signup. Please try again." },
				{ status: 502 },
			);
		}
	} catch (error) {
		console.error("Waitlist webhook request failed", error);
		return NextResponse.json(
			{ error: "Could not save your signup. Please try again." },
			{ status: 502 },
		);
	}

	return NextResponse.json({ ok: true });
}
