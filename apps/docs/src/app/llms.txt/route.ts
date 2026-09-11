import { llms } from "fumadocs-core/source";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
	const index = (await llms(source).index()).replace(
		/\]\((\/[^)]+)\)/gu,
		"](https://docs.zuse.sh$1.md)",
	);

	return new Response(index, {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
}
