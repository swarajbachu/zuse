import { Effect, Schema } from "effect";

import { type ApiError, badRequest } from "./errors.ts";

export const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export const decodeBody = <A, I>(
	schema: Schema.Codec<A, I>,
	request: Request,
): Effect.Effect<A, ApiError> =>
	Effect.tryPromise({
		try: (): Promise<unknown> => request.json(),
		catch: () => badRequest("invalid_json"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError(() => badRequest("invalid_request")),
	);

export const decodePathSegment = (
	segment: string,
): Effect.Effect<string, ApiError> =>
	Effect.try({
		try: () => decodeURIComponent(segment),
		catch: () => badRequest("invalid_path_encoding"),
	});
