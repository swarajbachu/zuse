import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const llmUserAgent =
	/(?:ChatGPT-User|GPTBot|Claude-User|ClaudeBot|Perplexity-User|PerplexityBot|Google-Extended|cohere-ai)/i;
const { rewrite: rewriteMarkdown } = rewritePath(
	"{/*path}",
	"/api/markdown{/*path}",
);

export function proxy(request: NextRequest) {
	const userAgent = request.headers.get("user-agent") ?? "";
	if (!isMarkdownPreferred(request) && !llmUserAgent.test(userAgent)) {
		return NextResponse.next();
	}

	const destination =
		request.nextUrl.pathname === "/"
			? "/api/markdown/start"
			: rewriteMarkdown(request.nextUrl.pathname);
	if (!destination) return NextResponse.next();

	return NextResponse.rewrite(new URL(destination, request.nextUrl), {
		headers: { Vary: "Accept, User-Agent" },
	});
}

export const config = {
	matcher: [
		"/((?!api|_next/static|_next/image|favicon.ico|app-icon.png|robots.txt|llms.txt|llms-full.txt|.*\\.[a-zA-Z0-9]+$).*)",
	],
};
