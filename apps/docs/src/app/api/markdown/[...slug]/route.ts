import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export async function GET(
	_request: Request,
	context: { params: Promise<{ slug: string[] }> },
) {
	const page = source.getPage((await context.params).slug);
	if (!page) return new Response("Not found", { status: 404 });

	return new Response(await getLLMText(page), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=0, s-maxage=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
