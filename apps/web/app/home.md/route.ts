import { HOME_MARKDOWN } from "@/lib/agent-content";

export function GET() {
	return new Response(HOME_MARKDOWN, {
		headers: {
			"Cache-Control": "public, max-age=0, s-maxage=3600",
			"Content-Type": "text/markdown; charset=utf-8",
			Vary: "Accept",
		},
	});
}
