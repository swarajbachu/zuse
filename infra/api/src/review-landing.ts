import { buildReviewFixLink } from "@zuse/client-runtime/review-links";
import { HOSTED_APP_URL } from "@zuse/contracts";

const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
/** Public landing holds opaque navigation intent only; every artifact read requires authentication. */
export function reviewLanding(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== "/review/fix") return null;
	if (request.method !== "GET")
		return new Response("Method not allowed", { status: 405 });
	const runId = url.searchParams.get("runId"),
		findingId = url.searchParams.get("findingId");
	if (
		!runId ||
		url.searchParams.getAll("runId").length !== 1 ||
		url.searchParams.getAll("findingId").length > 1 ||
		[...url.searchParams.keys()].some((k) => k !== "runId" && k !== "findingId")
	)
		return new Response("Invalid review link", { status: 400 });
	let desktop: string;
	try {
		desktop = buildReviewFixLink({
			runId,
			...(findingId !== null ? { findingId } : {}),
		});
	} catch {
		return new Response("Invalid review link", { status: 400 });
	}
	const browser = new URL(HOSTED_APP_URL);
	browser.searchParams.set("reviewRunId", runId);
	if (findingId !== null)
		browser.searchParams.set("reviewFindingId", findingId);
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Zuse Review</title><style>body{font:15px system-ui;max-width:34rem;margin:12vh auto;padding:24px;background:#111;color:#eee}a{display:inline-block;color:#b8ee55;margin:12px 20px 12px 0}textarea{box-sizing:border-box;width:100%;background:#222;color:#ddd;border:0;padding:10px}p{line-height:1.5;color:#aaa}</style></head><body><main><h1>Open this review in Zuse</h1><p>Sign in to view the findings. Zuse will check your repository access and the current PR before you choose a workspace and agent to fix them.</p><a href="${escapeHtml(desktop)}">Open Zuse</a><a href="${escapeHtml(browser.href)}">Continue in browser</a><p>If Zuse is unavailable, save this link and open it later. No fix starts automatically.</p><label for="link">Review link</label><textarea id="link" readonly rows="3">${escapeHtml(url.href)}</textarea></main></body></html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
			},
		},
	);
}
