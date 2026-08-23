import { methodNotAllowed, preflightResponse } from "@/lib/api-method";
import { openApiDocument } from "@/lib/openapi";

export function GET() {
	return Response.json(openApiDocument, {
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "public, max-age=0, s-maxage=3600",
		},
	});
}

const unsupportedMethod = () => methodNotAllowed(["GET"]);

export const POST = unsupportedMethod;
export const PUT = unsupportedMethod;
export const PATCH = unsupportedMethod;
export const DELETE = unsupportedMethod;
export const OPTIONS = () => preflightResponse(["GET"]);
