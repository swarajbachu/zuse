export type ApiErrorCode =
	| "INVALID_EMAIL"
	| "INVALID_JSON"
	| "METHOD_NOT_ALLOWED"
	| "NOT_FOUND"
	| "NOT_ACCEPTABLE"
	| "SERVICE_UNAVAILABLE"
	| "UNSUPPORTED_MEDIA_TYPE"
	| "UPSTREAM_ERROR";

export type ApiErrorBody = {
	error: {
		code: ApiErrorCode;
		message: string;
		resolution: string;
	};
};

export const jsonError = (
	status: number,
	code: ApiErrorCode,
	message: string,
	resolution: string,
	headers?: HeadersInit,
) =>
	Response.json(
		{
			error: { code, message, resolution },
		} satisfies ApiErrorBody,
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				...headers,
			},
		},
	);
