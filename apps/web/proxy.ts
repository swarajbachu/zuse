import { isWebsiteLocale, websitePath } from "@zuse/i18n/registry";
import { type NextRequest, NextResponse } from "next/server";
import { NOT_FOUND_MARKDOWN } from "@/lib/agent-content";
import { jsonError } from "@/lib/api-error";
import { appendVary, negotiateContent } from "@/lib/content-negotiation";
import {
	LANGUAGE_COOKIE,
	LANGUAGE_COOKIE_MAX_AGE,
	resolveWebsiteLanguage,
} from "@/lib/language-preference";
import { LEGAL_PAGE_PATHS } from "@/lib/legal-pages";

const MARKDOWN_ALTERNATE = '</home.md>; rel="alternate"; type="text/markdown"';

const knownPage = (pathname: string) =>
	pathname === "/" ||
	isWebsiteLocale(pathname.slice(1)) ||
	pathname === "/blog" ||
	pathname.startsWith("/blog/") ||
	pathname === "/changelog" ||
	pathname === "/developers" ||
	LEGAL_PAGE_PATHS.has(pathname) ||
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

	// An explicit English link must not loop through automatic root detection.
	if (
		pathname === "/en" &&
		(request.method === "GET" || request.method === "HEAD")
	) {
		const url = request.nextUrl.clone();
		url.pathname = "/";
		const response = NextResponse.redirect(url, 307);
		response.cookies.set(LANGUAGE_COOKIE, "en", {
			path: "/",
			maxAge: LANGUAGE_COOKIE_MAX_AGE,
			sameSite: "lax",
			secure: request.nextUrl.protocol === "https:",
		});
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}

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

		const locale = resolveWebsiteLanguage(
			request.cookies.get(LANGUAGE_COOKIE)?.value,
			request.headers.get("accept-language"),
			request.headers.get("x-vercel-ip-country"),
		);
		const url = request.nextUrl.clone();
		url.pathname = websitePath(locale);
		const response = withNegotiationHeaders(
			locale === "en" ? NextResponse.next() : NextResponse.redirect(url, 307),
		);
		// Never share a visitor's redirect or English response with another visitor.
		response.headers.set("Cache-Control", "private, no-store");
		for (const header of ["Accept-Language", "Cookie", "X-Vercel-IP-Country"]) {
			response.headers.set(
				"Vary",
				appendVary(response.headers.get("Vary"), header),
			);
		}
		return response;
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
