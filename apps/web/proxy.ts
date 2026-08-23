import { type NextRequest, NextResponse } from "next/server";
import { NOT_FOUND_MARKDOWN } from "@/lib/agent-content";
import { jsonError } from "@/lib/api-error";
import { appendVary, negotiateContent } from "@/lib/content-negotiation";

const MARKDOWN_ALTERNATE = '</home.md>; rel="alternate"; type="text/markdown"';

const knownPage = (pathname: string) =>
	pathname === "/" ||
	pathname === "/blog" ||
	pathname.startsWith("/blog/") ||
	pathname === "/changelog" ||
	pathname === "/developers" ||
	pathname === "/privacy" ||
	pathname === "/docs" ||
	pathname.startsWith("/docs/");

const publicMachineRoute = (pathname: string) =>
	pathname === "/download" ||
	pathname === "/home.md" ||
	pathname === "/llms.txt" ||
	pathname === "/manifest.webmanifest" ||
	pathname === "/openapi.json" ||
	pathname === "/robots.txt" ||
	pathname === "/sitemap.xml";

const publicApiRoute = (pathname: string) =>
	pathname === "/api/openapi.json" || pathname === "/api/waitlist";

const withNegotiationHeaders = (response: NextResponse) => {
	response.headers.set(
		"Vary",
		appendVary(response.headers.get("Vary"), "Accept"),
	);
	response.headers.set(
		"Vary",
		appendVary(response.headers.get("Vary"), "Accept-Encoding"),
	);
	response.headers.set("Link", MARKDOWN_ALTERNATE);
	return response;
};

export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	if (pathname.startsWith("/api/") && !publicApiRoute(pathname)) {
		return jsonError(
			404,
			"NOT_FOUND",
			"The requested Zuse API endpoint does not exist.",
			"Read /openapi.json for the complete public API surface.",
		);
	}

	if (
		pathname === "/" &&
		(request.method === "GET" || request.method === "HEAD")
	) {
		const representation = negotiateContent(request.headers.get("accept"));

		if (representation === "markdown") {
			return withNegotiationHeaders(
				NextResponse.rewrite(new URL("/home.md", request.url)),
			);
		}
		if (representation === "unsupported") {
			const response = jsonError(
				406,
				"NOT_ACCEPTABLE",
				"The homepage is available as HTML or Markdown.",
				"Send Accept: text/html or Accept: text/markdown.",
				{ Vary: "Accept, Accept-Encoding", Link: MARKDOWN_ALTERNATE },
			);
			return response;
		}

		return withNegotiationHeaders(NextResponse.next());
	}

	const isKnownRoute =
		knownPage(pathname) ||
		publicMachineRoute(pathname) ||
		publicApiRoute(pathname) ||
		pathname.startsWith("/_next/") ||
		pathname === "/favicon.ico" ||
		pathname === "/icon.png" ||
		pathname === "/apple-icon.png" ||
		pathname === "/og.png" ||
		pathname === "/app-icon.png";

	if (
		!isKnownRoute &&
		(request.method === "GET" || request.method === "HEAD") &&
		negotiateContent(request.headers.get("accept")) === "markdown"
	) {
		return new Response(NOT_FOUND_MARKDOWN, {
			status: 404,
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "text/markdown; charset=utf-8",
				Vary: "Accept, Accept-Encoding",
			},
		});
	}

	return NextResponse.next();
}

export const config = {
	matcher: "/:path*",
};
