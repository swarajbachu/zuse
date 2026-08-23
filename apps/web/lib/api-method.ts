import { jsonError } from "@/lib/api-error";

export const methodNotAllowed = (allowedMethods: readonly string[]) =>
	jsonError(
		405,
		"METHOD_NOT_ALLOWED",
		"This API endpoint does not support the requested HTTP method.",
		`Use one of the supported methods: ${allowedMethods.join(", ")}.`,
		{ Allow: allowedMethods.join(", ") },
	);

export const preflightResponse = (allowedMethods: readonly string[]) =>
	new Response(null, {
		status: 204,
		headers: {
			Allow: allowedMethods.join(", "),
			"Access-Control-Allow-Headers": "Content-Type",
			"Access-Control-Allow-Methods": allowedMethods.join(", "),
			"Access-Control-Allow-Origin": "*",
		},
	});
