import { LLMS_TEXT } from "@/lib/agent-content";

export const dynamic = "force-static";

export function GET() {
	return new Response(LLMS_TEXT, {
		headers: {
			"Cache-Control": "public, max-age=0, s-maxage=3600",
			"Content-Type": "text/markdown; charset=utf-8",
			Vary: "Accept",
		},
	});
}
